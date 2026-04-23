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
    const query = Product.findById(productId);
    if (session) query.session(session);
    
    const product = await query;
    if (!product) throw new AppError('Product not found', 404);
    
    const variant = product.variants.id(variantId);
    if (!variant) throw new AppError('Variant not found', 404);
    
    return { product, variant };
};

const addLocationStockQuery = (updateQuery, arrayFilters, variant, storeId, quantity, locIdentifier = 'loc') => {
    // ENTERPRISE FIX: Safe array fallback for legacy products without locationInventory initialized
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
            // ENTERPRISE FIX: Identify EXACTLY which item caused the race condition for precise frontend error
            const currentStock = await Product.find({ _id: { $in: productIds } }).select('name variants').session(session).lean();
            let failedItemName = 'an item in your cart';
            
            for (const item of items) {
                const prod = currentStock.find(p => p._id.toString() === item.productId.toString());
                if (prod) {
                    const variant = prod.variants.find(v => v._id.toString() === item.variantId.toString());
                    // If the found stock is strictly less than what we asked to deduct, we found the culprit
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
        // ENTERPRISE FIX: Project heavily strips unneeded strings (like notes, deliveryAddress) before unwinding to save massive amounts of RAM
        { $project: { items: 1 } },
        { $unwind: "$items" },
        { $group: { _id: "$items.variantId", totalSold: { $sum: "$items.qty" } } }
    ]).allowDiskUse(true); 

    let variantSales = {};
    velocityAgg.forEach(v => {
        if (v._id) variantSales[v._id.toString()] = v.totalSold;
    });

    // OPTIMIZATION: Critical memory leak patch. Using .lean() converts heavy Mongoose documents into plain JS objects, 
    // saving hundreds of megabytes of RAM when iterating over thousands of products during background jobs.
    const productCursor = Product.find({ isActive: true }).select('name variants').lean().cursor();
    
    let lowStockItems = [];
    let deadStockItems = [];
    let bulkOps = []; 
    const BATCH_SIZE = 500; 
    
    for await (let p of productCursor) {
        let isModified = false;
        let updateFields = {}; // ENTERPRISE FIX: Strict dot-notation targeting
        
        if (p.variants) {
            p.variants.forEach((v, index) => {
                const totalSold = variantSales[v._id.toString()] || 0;
                const dailyAvg = totalSold / velocityDays;
                
                const avgDailySalesFixed = Number(dailyAvg.toFixed(2));
                const daysOfStockFixed = dailyAvg > 0 ? Number((v.stock / dailyAvg).toFixed(1)) : 999;

                // ENTERPRISE FIX: Update ONLY the specific stats using array indices.
                // This prevents the cron job from accidentally overwriting live stock updates (race conditions)
                updateFields[`variants.${index}.averageDailySales`] = avgDailySalesFixed;
                updateFields[`variants.${index}.daysOfStock`] = daysOfStockFixed;
                isModified = true;

                if (v.stock <= (v.lowStockThreshold || lowStockThreshold) || (daysOfStockFixed < 3 && v.stock > 0)) {
                    lowStockItems.push({ name: p.name, variant: v.weightOrVolume, stock: v.stock, daysLeft: daysOfStockFixed });
                }
                
                if (v.stock > deadStockQty && daysOfStockFixed > deadStockDays) {
                    deadStockItems.push({ name: p.name, variant: v.weightOrVolume, stock: v.stock, daysLeft: daysOfStockFixed });
                }
            });
        }
        
        if (isModified) {
            bulkOps.push({
                updateOne: {
                    filter: { _id: p._id },
                    update: { $set: updateFields } // Applies only dot-notation fields, leaves stock alone
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
            $push: { "variants.$[var].purchaseHistory": purchaseHistoryEntry },
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
        );
        
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
            $push: { "variants.$[var].returnHistory": returnHistoryEntry },
            $inc: { "variants.$[var].stock": -Number(returnedQuantity) }
        };
        
        const arrayFilters = [{ "var._id": variantId }];

        if (storeId) {
            // ENTERPRISE FIX: Safe array fallback
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
        );

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

        // ENTERPRISE FIX: Safe array fallback
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
        );
        
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
