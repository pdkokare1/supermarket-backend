/* services/inventoryService.js */

const Product = require('../models/Product');
const Order = require('../models/Order'); 
const distributorService = require('./distributorService'); 
const { withTransaction } = require('../utils/dbUtils'); 
const AppError = require('../utils/AppError'); 
const auditService = require('./auditService'); 
const appEvents = require('../utils/eventEmitter'); 
const { invalidateProductCache } = require('./productCacheService');

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

const getProductAndVariant = async (productId, variantId, session = null) => {
    // OPTIMIZATION: .lean() added. We do not need a hydrated document just to read current stock levels.
    const query = Product.findById(productId).lean();
    if (session) query.session(session);
    
    const product = await query;
    if (!product) throw new AppError('Product not found', 404);
    
    // OPTIMIZATION: Replaced heavy Mongoose .id() method with native JS .find() since the object is now a POJO.
    const variant = product.variants.find(v => v._id.toString() === variantId.toString());
    if (!variant) throw new AppError('Variant not found', 404);
    
    return { product, variant };
};

const addLocationStockQuery = (updateQuery, arrayFilters, variant, storeId, quantity, locIdentifier = 'loc') => {
    const hasStore = (variant.locationInventory || []).some(l => l.storeId && l.storeId.toString() === storeId.toString());
    if (hasStore) {
        updateQuery.$inc = updateQuery.$inc || {};
        updateQuery.$inc[`variants.$[var].locationInventory.$[${locIdentifier}].stock`] = Number(quantity);
        arrayFilters.push({ [`${locIdentifier}.storeId`]: storeId });
    } else {
        updateQuery.$push = updateQuery.$push || {};
        updateQuery.$push["variants.$[var].locationInventory"] = { storeId: storeId, stock: Number(quantity) };
    }
};

// ==========================================
// --- INVENTORY OPERATIONS ---
// ==========================================

exports.restoreInventory = async (items, storeId, session) => {
    const bulkOperations = [];
    for (const item of items) {
        if (storeId) {
            bulkOperations.push({ 
                updateOne: { 
                    filter: { _id: item.productId }, 
                    update: { $inc: { "variants.$[var].stock": item.qty, "variants.$[var].locationInventory.$[loc].stock": item.qty } }, 
                    arrayFilters: [{ "var._id": item.variantId }, { "loc.storeId": storeId }] 
                } 
            });
        } else {
            bulkOperations.push({ 
                updateOne: { 
                    filter: { _id: item.productId, "variants._id": item.variantId }, 
                    update: { $inc: { "variants.$.stock": item.qty } } 
                } 
            });
        }
    }
    if (bulkOperations.length > 0) {
        await Product.bulkWrite(bulkOperations, { session });
        await invalidateProductCache();
    }
};

exports.deductInventory = async (items, storeId, session) => {
    const productIds = items.map(item => item.productId);
    
    const bulkOperations = [];

    for (const item of items) {
        if (storeId) {
            bulkOperations.push({
                updateOne: {
                    filter: { _id: item.productId },
                    update: { 
                        $inc: { 
                            "variants.$[var].stock": -item.qty,
                            "variants.$[var].locationInventory.$[loc].stock": -item.qty 
                        } 
                    },
                    arrayFilters: [
                        { "var._id": item.variantId, "var.stock": { $gte: item.qty } }, 
                        { "loc.storeId": storeId, "loc.stock": { $gte: item.qty } }
                    ]
                }
            });
        } else {
            bulkOperations.push({
                updateOne: {
                    filter: { _id: item.productId },
                    update: { $inc: { "variants.$[var].stock": -item.qty } },
                    arrayFilters: [{ "var._id": item.variantId, "var.stock": { $gte: item.qty } }]
                }
            });
        }
    }

    if (bulkOperations.length > 0) {
        const bulkResult = await Product.bulkWrite(bulkOperations, { session });
        
        if (bulkResult.modifiedCount !== items.length) {
            const currentStock = await Product.find({ _id: { $in: productIds } }).select('name variants').session(session).lean();
            let failedItemName = 'an item in your cart';
            
            const stockMap = new Map(currentStock.map(p => [p._id.toString(), p]));

            for (const item of items) {
                const prod = stockMap.get(item.productId.toString());
                if (prod) {
                    const variantMap = new Map(prod.variants.map(v => [v._id.toString(), v]));
                    const variant = variantMap.get(item.variantId.toString());
                    
                    if (variant && variant.stock < item.qty) {
                        failedItemName = `${prod.name} (${variant.weightOrVolume})`;
                        break;
                    }
                }
            }
            
            return { success: false, message: `Oversell Prevented: "${failedItemName}" does not have enough stock remaining. Another customer just purchased it.` };
        }
        await invalidateProductCache();
    }
    return { success: true };
};

// ==========================================
// --- CRON ABSTRACTIONS ---
// ==========================================

exports.getExpiringProducts = async (days = 7) => {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + days);

    return await Product.aggregate([
        { $match: { isActive: true, "variants.expiryDate": { $ne: null } } },
        { $unwind: "$variants" },
        { $match: { "variants.expiryDate": { $lte: targetDate }, "variants.stock": { $gt: 0 } } },
        { $project: {
            _id: 0,
            productId: "$_id",
            name: 1,
            variant: "$variants.weightOrVolume",
            stock: "$variants.stock",
            expiryDate: "$variants.expiryDate"
        }}
    ]).allowDiskUse(true);
};

exports.calculateSalesVelocityAndStock = async (velocityDays, lowStockThreshold, deadStockQty, deadStockDays) => {
    const dateAgo = new Date();
    dateAgo.setDate(dateAgo.getDate() - velocityDays);

    const velocityAgg = await Order.aggregate([
        { $match: { createdAt: { $gte: dateAgo }, status: { $in: ['Completed', 'Dispatched'] } } },
        { $project: { items: 1 } },
        { $unwind: "$items" },
        { $group: { _id: "$items.variantId", totalSold: { $sum: "$items.qty" } } }
    ]).allowDiskUse(true); 

    let variantSales = {};
    velocityAgg.forEach(v => {
        if (v._id) variantSales[v._id.toString()] = v.totalSold;
    });

    const productCursor = Product.find({ isActive: true }).select('name variants').lean().cursor();
    
    let lowStockItems = [];
    let deadStockItems = [];
    let bulkOps = []; 
    const BATCH_SIZE = 500; 
    
    for await (let p of productCursor) {
        if (p.variants) {
            p.variants.forEach((v) => {
                const totalSold = variantSales[v._id.toString()] || 0;
                const dailyAvg = totalSold / velocityDays;
                
                const avgDailySalesFixed = Number(dailyAvg.toFixed(2));
                const daysOfStockFixed = dailyAvg > 0 ? Number((v.stock / dailyAvg).toFixed(1)) : 999;

                // ENTERPRISE FIX: Replaced dangerous Array-Index mutation with strict arrayFilter matching.
                // Prevents corrupting the wrong variant if an admin reorders or deletes a variant mid-cron run.
                bulkOps.push({
                    updateOne: {
                        filter: { _id: p._id },
                        update: { 
                            $set: { 
                                "variants.$[var].averageDailySales": avgDailySalesFixed,
                                "variants.$[var].daysOfStock": daysOfStockFixed
                            } 
                        },
                        arrayFilters: [{ "var._id": v._id }]
                    }
                });

                if (v.stock <= (v.lowStockThreshold || lowStockThreshold) || (daysOfStockFixed < 3 && v.stock > 0)) {
                    lowStockItems.push({ name: p.name, variant: v.weightOrVolume, stock: v.stock, daysLeft: daysOfStockFixed });
                }
                
                if (v.stock > deadStockQty && daysOfStockFixed > deadStockDays) {
                    deadStockItems.push({ name: p.name, variant: v.weightOrVolume, stock: v.stock, daysLeft: daysOfStockFixed });
                }
            });
        }

        if (bulkOps.length >= BATCH_SIZE) {
            await Product.bulkWrite(bulkOps);
            bulkOps = []; 
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    if (bulkOps.length > 0) {
        await Product.bulkWrite(bulkOps);
    }

    return { lowStockItems, deadStockItems };
};

// ==========================================
// --- SERVICE EXPORTS ---
// ==========================================

exports.processRestock = async (productId, payload) => {
    return withTransaction(async (session) => {
        const { variantId, invoiceNumber, addedQuantity, purchasingPrice, newSellingPrice, paymentStatus, storeId } = payload;
        
        const { product, variant } = await getProductAndVariant(productId, variantId, session);
        
        const purchaseHistoryEntry = { 
            invoiceNumber, 
            addedQuantity: Number(addedQuantity), 
            purchasingPrice: Number(purchasingPrice), 
            sellingPrice: Number(newSellingPrice),
            storeId: storeId 
        };

        const updateQuery = {
            // ENTERPRISE FIX: Native capped arrays via $slice prevents 16MB BSON Document Crash over time.
            $push: { 
                "variants.$[var].purchaseHistory": {
                    $each: [purchaseHistoryEntry],
                    $slice: -50 // Keep only the latest 50 entries to preserve DB memory limits
                } 
            },
            $inc: { "variants.$[var].stock": Number(addedQuantity) },
            $set: { "variants.$[var].price": Number(newSellingPrice) }
        };
        
        const arrayFilters = [{ "var._id": variantId }];

        if (storeId) {
            addLocationStockQuery(updateQuery, arrayFilters, variant, storeId, addedQuantity, 'loc');
        }

        const updatedProduct = await Product.findOneAndUpdate(
            { _id: productId },
            updateQuery,
            { new: true, arrayFilters, session }
        ).lean(); // OPTIMIZATION: Zero hydration overhead
        
        if (paymentStatus === 'Credit' && updatedProduct.distributorName) {
            const totalCost = Number(addedQuantity) * Number(purchasingPrice);
            await distributorService.incrementPendingAmount(updatedProduct.distributorName, totalCost, session);
        }

        appEvents.emit('PRODUCT_UPDATED', { 
            productId: updatedProduct._id, 
            message: 'Stock Refilled', 
            storeId: storeId 
        });

        await invalidateProductCache();
        return updatedProduct;
    });
};

exports.processRTV = async (productId, payload) => {
    return withTransaction(async (session) => {
        const { variantId, distributorName, returnedQuantity, refundAmount, reason, storeId } = payload;
        
        const { product, variant } = await getProductAndVariant(productId, variantId, session);
        
        if (variant.stock < returnedQuantity) {
            throw new AppError('Not enough stock to return', 400);
        }

        const returnHistoryEntry = { distributorName, returnedQuantity: Number(returnedQuantity), refundAmount: Number(refundAmount), reason, storeId };

        const updateQuery = {
            // ENTERPRISE FIX: Native capped arrays via $slice.
            $push: { 
                "variants.$[var].returnHistory": {
                    $each: [returnHistoryEntry],
                    $slice: -50
                } 
            },
            $inc: { "variants.$[var].stock": -Number(returnedQuantity) }
        };
        
        const arrayFilters = [{ "var._id": variantId }];

        if (storeId) {
            let locStock = (variant.locationInventory || []).find(l => l.storeId && l.storeId.toString() === storeId);
            if (locStock && locStock.stock >= returnedQuantity) {
                updateQuery.$inc["variants.$[var].locationInventory.$[loc].stock"] = -Number(returnedQuantity);
                arrayFilters.push({ "loc.storeId": storeId });
            }
        }
        
        const updatedProduct = await Product.findOneAndUpdate(
            { _id: productId },
            updateQuery,
            { new: true, arrayFilters, session }
        ).lean(); // OPTIMIZATION: Zero hydration overhead

        appEvents.emit('PRODUCT_UPDATED', { 
            productId: updatedProduct._id, 
            message: 'Stock Returned', 
            storeId: storeId 
        });

        await invalidateProductCache();
        return updatedProduct;
    });
};

exports.processTransfer = async (payload, username, logError) => {
    return withTransaction(async (session) => {
        const { productId, variantId, fromStoreId, toStoreId, quantity } = payload;
        
        if (!productId || !variantId || !fromStoreId || !toStoreId || !quantity || quantity <= 0) {
            throw new AppError('Invalid transfer parameters.', 400);
        }

        const { product, variant } = await getProductAndVariant(productId, variantId, session);

        let fromLoc = (variant.locationInventory || []).find(l => l.storeId.toString() === fromStoreId);
        if (!fromLoc || fromLoc.stock < quantity) {
            throw new AppError('Insufficient stock at source location.', 400);
        }

        const updateQuery = {
            $inc: { "variants.$[var].locationInventory.$[fromLoc].stock": -Number(quantity) }
        };
        
        const arrayFilters = [
            { "var._id": variantId },
            { "fromLoc.storeId": fromStoreId }
        ];

        addLocationStockQuery(updateQuery, arrayFilters, variant, toStoreId, quantity, 'toLoc');

        const updatedProduct = await Product.findOneAndUpdate(
            { _id: productId },
            updateQuery,
            { new: true, arrayFilters, session }
        ).lean(); // OPTIMIZATION: Zero hydration overhead
        
        await auditService.logEvent({
            action: 'STOCK_TRANSFER',
            targetType: 'Product',
            targetId: updatedProduct._id.toString(),
            username: username,
            details: { variantId, fromStoreId, toStoreId, quantity },
            session,
            logError
        });

        appEvents.emit('PRODUCT_UPDATED', { 
            productId: updatedProduct._id, 
            message: 'Stock Transferred' 
        });
        
        await invalidateProductCache();
        return updatedProduct;
    });
};
