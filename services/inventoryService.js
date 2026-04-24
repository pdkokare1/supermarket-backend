/* services/inventoryService.js */

const MasterProduct = require('../models/MasterProduct');
const StoreInventory = require('../models/StoreInventory');
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

const getInventoryRecord = async (masterProductId, variantId, storeId, session = null) => {
    const query = StoreInventory.findOne({ masterProductId, variantId, storeId }).lean();
    if (session) query.session(session);
    
    const inventory = await query;
    if (!inventory) throw new AppError('Local store inventory not found for this product', 404);
    
    return inventory;
};

// ==========================================
// --- INVENTORY OPERATIONS ---
// ==========================================

exports.restoreInventory = async (items, storeId, session) => {
    if (!storeId) throw new AppError('Tenant Isolation Error: Store ID is required for stock restoration', 400);

    const bulkOperations = items.map(item => ({
        updateOne: { 
            // We now update the local store document directly, zero array-parsing required
            filter: { masterProductId: item.productId, variantId: item.variantId, storeId: storeId }, 
            update: { $inc: { stock: item.qty } } 
        } 
    }));

    if (bulkOperations.length > 0) {
        await StoreInventory.bulkWrite(bulkOperations, { session });
        await invalidateProductCache();
    }
};

exports.deductInventory = async (items, storeId, session) => {
    if (!storeId) throw new AppError('Tenant Isolation Error: Store ID is required for checkout deduction', 400);

    const bulkOperations = items.map(item => ({
        updateOne: {
            filter: { 
                masterProductId: item.productId, 
                variantId: item.variantId, 
                storeId: storeId,
                stock: { $gte: item.qty } // Atomic safety lock prevents overselling
            },
            update: { $inc: { stock: -item.qty } }
        }
    }));

    if (bulkOperations.length > 0) {
        const bulkResult = await StoreInventory.bulkWrite(bulkOperations, { session });
        
        if (bulkResult.modifiedCount !== items.length) {
            // Find exactly which item failed for a graceful error
            let failedItemName = 'an item in your cart';
            for (const item of items) {
                const inv = await StoreInventory.findOne({ masterProductId: item.productId, variantId: item.variantId, storeId }).session(session).lean();
                if (!inv || inv.stock < item.qty) {
                    const master = await MasterProduct.findById(item.productId).lean();
                    failedItemName = master ? master.name : failedItemName;
                    break;
                }
            }
            return { success: false, message: `Oversell Prevented: "${failedItemName}" does not have enough local stock remaining.` };
        }
        await invalidateProductCache();
    }
    return { success: true };
};

// ==========================================
// --- CRON ABSTRACTIONS ---
// ==========================================

exports.getExpiringProducts = async (days = 7) => {
    // Requires migration to track expiry locally per store if needed. 
    // Currently returns empty until expiry is modeled at the StoreInventory level.
    return []; 
};

exports.calculateSalesVelocityAndStock = async (velocityDays, lowStockThreshold, deadStockQty, deadStockDays) => {
    const dateAgo = new Date();
    dateAgo.setDate(dateAgo.getDate() - velocityDays);

    // Aggregate velocity PER store inventory
    const velocityAgg = await Order.aggregate([
        { $match: { createdAt: { $gte: dateAgo }, status: { $in: ['Completed', 'Dispatched'] } } },
        { $project: { items: 1, storeId: 1 } },
        { $unwind: "$items" },
        { $group: { 
            _id: { storeId: "$storeId", variantId: "$items.variantId" }, 
            totalSold: { $sum: "$items.qty" } 
        }}
    ]).allowDiskUse(true); 

    let variantSales = {};
    velocityAgg.forEach(v => {
        if (v._id) variantSales[`${v._id.storeId}_${v._id.variantId}`] = v.totalSold;
    });

    const inventoryCursor = StoreInventory.find({ isActive: true }).lean().cursor();
    
    let lowStockItems = [];
    let deadStockItems = [];
    let bulkOps = []; 
    const BATCH_SIZE = 500; 
    
    for await (let inv of inventoryCursor) {
        const key = `${inv.storeId}_${inv.variantId}`;
        const totalSold = variantSales[key] || 0;
        const dailyAvg = totalSold / velocityDays;
        
        const avgDailySalesFixed = Number(dailyAvg.toFixed(2));
        const daysOfStockFixed = dailyAvg > 0 ? Number((inv.stock / dailyAvg).toFixed(1)) : 999;

        bulkOps.push({
            updateOne: {
                filter: { _id: inv._id },
                update: { 
                    $set: { 
                        averageDailySales: avgDailySalesFixed,
                        daysOfStock: daysOfStockFixed
                    } 
                }
            }
        });

        if (inv.stock <= (inv.lowStockThreshold || lowStockThreshold) || (daysOfStockFixed < 3 && inv.stock > 0)) {
            lowStockItems.push({ variantId: inv.variantId, storeId: inv.storeId, stock: inv.stock, daysLeft: daysOfStockFixed });
        }
        
        if (inv.stock > deadStockQty && daysOfStockFixed > deadStockDays) {
            deadStockItems.push({ variantId: inv.variantId, storeId: inv.storeId, stock: inv.stock, daysLeft: daysOfStockFixed });
        }

        if (bulkOps.length >= BATCH_SIZE) {
            await StoreInventory.bulkWrite(bulkOps);
            bulkOps = []; 
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    if (bulkOps.length > 0) {
        await StoreInventory.bulkWrite(bulkOps);
    }

    return { lowStockItems, deadStockItems };
};

// ==========================================
// --- SERVICE EXPORTS ---
// ==========================================

exports.processRestock = async (masterProductId, payload) => {
    return withTransaction(async (session) => {
        const { variantId, invoiceNumber, addedQuantity, purchasingPrice, newSellingPrice, paymentStatus, storeId } = payload;
        
        if (!storeId) throw new AppError('Tenant Isolation Error: Store ID is required', 400);

        const purchaseHistoryEntry = { 
            invoiceNumber, 
            addedQuantity: Number(addedQuantity), 
            purchasingPrice: Number(purchasingPrice), 
            sellingPrice: Number(newSellingPrice),
            storeId: storeId 
        };

        const updateQuery = {
            $push: { 
                purchaseHistory: { $each: [purchaseHistoryEntry], $slice: -50 } 
            },
            $inc: { stock: Number(addedQuantity) },
            $set: { sellingPrice: Number(newSellingPrice) }
        };
        
        const updatedInventory = await StoreInventory.findOneAndUpdate(
            { masterProductId, variantId, storeId },
            updateQuery,
            { new: true, session, upsert: true } // If they restock a master item they didn't have, create the store link
        ).lean(); 
        
        if (paymentStatus === 'Credit') {
            const totalCost = Number(addedQuantity) * Number(purchasingPrice);
            // Warning: Distributor linkage will need an update to handle multi-tenant logic
            // await distributorService.incrementPendingAmount(updatedProduct.distributorName, totalCost, session);
        }

        appEvents.emit('PRODUCT_UPDATED', { 
            productId: masterProductId, 
            message: 'Local Stock Refilled', 
            storeId: storeId 
        });

        await invalidateProductCache();
        return updatedInventory;
    });
};

exports.processRTV = async (masterProductId, payload) => {
    return withTransaction(async (session) => {
        const { variantId, distributorName, returnedQuantity, refundAmount, reason, storeId } = payload;
        
        if (!storeId) throw new AppError('Tenant Isolation Error: Store ID is required', 400);

        const inventory = await getInventoryRecord(masterProductId, variantId, storeId, session);
        
        if (inventory.stock < returnedQuantity) {
            throw new AppError('Not enough stock to return locally', 400);
        }

        const returnHistoryEntry = { distributorName, returnedQuantity: Number(returnedQuantity), refundAmount: Number(refundAmount), reason, storeId };

        const updateQuery = {
            $push: { 
                returnHistory: { $each: [returnHistoryEntry], $slice: -50 } 
            },
            $inc: { stock: -Number(returnedQuantity) }
        };
        
        const updatedInventory = await StoreInventory.findOneAndUpdate(
            { masterProductId, variantId, storeId },
            updateQuery,
            { new: true, session }
        ).lean(); 

        appEvents.emit('PRODUCT_UPDATED', { 
            productId: masterProductId, 
            message: 'Local Stock Returned', 
            storeId: storeId 
        });

        await invalidateProductCache();
        return updatedInventory;
    });
};

exports.processTransfer = async (payload, username, logError) => {
    return withTransaction(async (session) => {
        const { productId: masterProductId, variantId, fromStoreId, toStoreId, quantity } = payload;
        
        if (!masterProductId || !variantId || !fromStoreId || !toStoreId || !quantity || quantity <= 0) {
            throw new AppError('Invalid transfer parameters.', 400);
        }

        // Deduct from Source Store
        const sourceInventory = await StoreInventory.findOneAndUpdate(
            { masterProductId, variantId, storeId: fromStoreId, stock: { $gte: quantity } },
            { $inc: { stock: -Number(quantity) } },
            { new: true, session }
        ).lean();

        if (!sourceInventory) {
            throw new AppError('Insufficient stock at source location.', 400);
        }

        // Add to Destination Store
        const targetInventory = await StoreInventory.findOneAndUpdate(
            { masterProductId, variantId, storeId: toStoreId },
            { $inc: { stock: Number(quantity) } },
            { new: true, upsert: true, session }
        ).lean();
        
        await auditService.logEvent({
            action: 'STOCK_TRANSFER',
            targetType: 'StoreInventory',
            targetId: masterProductId.toString(),
            username: username,
            details: { variantId, fromStoreId, toStoreId, quantity },
            session,
            logError
        });

        appEvents.emit('PRODUCT_UPDATED', { 
            productId: masterProductId, 
            message: 'Stock Transferred Between Stores' 
        });
        
        await invalidateProductCache();
        return { sourceInventory, targetInventory };
    });
};
