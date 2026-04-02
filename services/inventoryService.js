/* services/inventoryService.js */

const Product = require('../models/Product');
const Distributor = require('../models/Distributor');
const Order = require('../models/Order'); 
const { withTransaction } = require('../utils/dbUtils'); 
const AppError = require('../utils/AppError'); 
const auditService = require('./auditService'); 

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

// ==========================================
// --- INVENTORY OPERATIONS ---
// ==========================================

exports.deductInventory = async (items, storeId, session) => {
    const productIds = items.map(item => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session).lean();
    
    const productMap = {};
    products.forEach(p => productMap[p._id.toString()] = p);

    const bulkOperations = [];

    for (const item of items) {
        const product = productMap[item.productId.toString()];
        if (!product) return { success: false, message: `Product not found: ${item.name}` };

        const variant = product.variants.find(v => v._id.toString() === item.variantId.toString());
        if (!variant) return { success: false, message: `Variant not found for item: ${item.name}` };

        if (variant.stock < item.qty) return { success: false, message: `Insufficient global stock for item: ${item.name}` };

        if (storeId) {
            const locStock = variant.locationInventory ? variant.locationInventory.find(l => l.storeId.toString() === storeId.toString()) : null;
            if (!locStock || locStock.stock < item.qty) {
                return { success: false, message: `Insufficient local store stock for item: ${item.name}` };
            }
            
            bulkOperations.push({
                updateOne: {
                    filter: { _id: item.productId },
                    update: { 
                        $inc: { 
                            "variants.$[var].stock": -item.qty,
                            "variants.$[var].locationInventory.$[loc].stock": -item.qty 
                        } 
                    },
                    arrayFilters: [{ "var._id": item.variantId }, { "loc.storeId": storeId }]
                }
            });
        } else {
            bulkOperations.push({
                updateOne: {
                    filter: { _id: item.productId, "variants._id": item.variantId },
                    update: { $inc: { "variants.$.stock": -item.qty } }
                }
            });
        }
    }

    if (bulkOperations.length > 0) await Product.bulkWrite(bulkOperations, { session });
    return { success: true };
};

// ==========================================
// --- CRON ABSTRACTIONS ---
// ==========================================

exports.getExpiringProducts = async (days = 7) => {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + days);

    const productCursor = Product.find({ isActive: true, "variants.expiryDate": { $ne: null } }).lean().cursor();
    let expiringItems = [];

    for await (const p of productCursor) {
        p.variants.forEach(v => {
            if (v.expiryDate && new Date(v.expiryDate) <= targetDate && v.stock > 0) {
                expiringItems.push({
                    productId: p._id, name: p.name, variant: v.weightOrVolume, 
                    stock: v.stock, expiryDate: v.expiryDate
                });
            }
        });
    }
    return expiringItems;
};

exports.calculateSalesVelocityAndStock = async (velocityDays, lowStockThreshold, deadStockQty, deadStockDays) => {
    const dateAgo = new Date();
    dateAgo.setDate(dateAgo.getDate() - velocityDays);

    const velocityAgg = await Order.aggregate([
        { $match: { createdAt: { $gte: dateAgo }, status: { $in: ['Completed', 'Dispatched'] } } },
        { $unwind: "$items" },
        { $group: { _id: "$items.variantId", totalSold: { $sum: "$items.qty" } } }
    ]);

    let variantSales = {};
    velocityAgg.forEach(v => {
        if (v._id) variantSales[v._id.toString()] = v.totalSold;
    });

    const productCursor = Product.find({ isActive: true }).cursor();
    let lowStockItems = [];
    let deadStockItems = [];
    let bulkOps = []; 
    
    for await (let p of productCursor) {
        let isModified = false;
        
        if (p.variants) {
            p.variants.forEach(v => {
                const totalSold = variantSales[v._id.toString()] || 0;
                const dailyAvg = totalSold / velocityDays;
                v.averageDailySales = Number(dailyAvg.toFixed(2));

                v.daysOfStock = dailyAvg > 0 ? Number((v.stock / dailyAvg).toFixed(1)) : 999;
                isModified = true;

                if (v.stock <= (v.lowStockThreshold || lowStockThreshold) || (v.daysOfStock < 3 && v.stock > 0)) {
                    lowStockItems.push({ name: p.name, variant: v.weightOrVolume, stock: v.stock, daysLeft: v.daysOfStock });
                }
                
                if (v.stock > deadStockQty && v.daysOfStock > deadStockDays) {
                    deadStockItems.push({ name: p.name, variant: v.weightOrVolume, stock: v.stock, daysLeft: v.daysOfStock });
                }
            });
        }
        
        if (isModified) {
            bulkOps.push({
                updateOne: {
                    filter: { _id: p._id },
                    update: { $set: { variants: p.variants } }
                }
            });
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
            const hasStore = variant.locationInventory.some(l => l.storeId && l.storeId.toString() === storeId);
            if (hasStore) {
                updateQuery.$inc["variants.$[var].locationInventory.$[loc].stock"] = Number(addedQuantity);
                arrayFilters.push({ "loc.storeId": storeId });
            } else {
                updateQuery.$push["variants.$[var].locationInventory"] = { storeId: storeId, stock: Number(addedQuantity) };
            }
        }

        const updatedProduct = await Product.findOneAndUpdate(
            { _id: productId },
            updateQuery,
            { new: true, arrayFilters, session }
        );
        
        if (paymentStatus === 'Credit' && updatedProduct.distributorName) {
            const totalCost = Number(addedQuantity) * Number(purchasingPrice);
            await Distributor.findOneAndUpdate(
                { name: updatedProduct.distributorName },
                { $inc: { totalPendingAmount: totalCost } },
                { upsert: true, session }
            );
        }
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
            let locStock = variant.locationInventory.find(l => l.storeId && l.storeId.toString() === storeId);
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

        let fromLoc = variant.locationInventory.find(l => l.storeId.toString() === fromStoreId);
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

        let toLoc = variant.locationInventory.find(l => l.storeId.toString() === toStoreId);
        if (toLoc) {
            updateQuery.$inc["variants.$[var].locationInventory.$[toLoc].stock"] = Number(quantity);
            arrayFilters.push({ "toLoc.storeId": toStoreId });
        } else {
            updateQuery.$push = {
                "variants.$[var].locationInventory": { storeId: toStoreId, stock: Number(quantity) }
            };
        }

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
        
        return updatedProduct;
    });
};
