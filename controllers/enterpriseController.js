/* controllers/enterpriseController.js */
'use strict';

const Order = require('../models/Order');
const Store = require('../models/Store');
const StoreInventory = require('../models/StoreInventory');
const MasterProduct = require('../models/MasterProduct'); 
const Distributor = require('../models/Distributor'); // Added for B2B Procurement
const AppError = require('../utils/AppError');
const appEvents = require('../utils/eventEmitter');

// --- ENTERPRISE MIDDLEWARE ---
// Authenticates machine-to-machine requests using the custom API Secret
const authenticateEnterprise = async (request) => {
    const apiKey = request.headers['x-enterprise-api-key'];
    if (!apiKey) throw new AppError('Missing Enterprise API Key in headers', 401);

    const store = await Store.findOne({ 
        "apiIntegration.apiSecretKey": apiKey, 
        storeType: 'ENTERPRISE', 
        isActive: true 
    });
    
    if (!store) throw new AppError('Invalid or Revoked Enterprise API Key', 403);

    return store;
};

// --- WEBHOOK: FULFILLMENT STATUS ---
// Called by partner systems (e.g., Croma POS) when their driver updates a delivery
exports.updateFulfillmentStatus = async (request, reply) => {
    const store = await authenticateEnterprise(request);
    const { partnerTrackingId, status, notes } = request.body;

    if (!partnerTrackingId || !status) {
        throw new AppError('partnerTrackingId and status are required in the payload', 400);
    }

    const validStatuses = ['Pending', 'Dispatched', 'Arrived', 'Delivered', 'Failed'];
    if (!validStatuses.includes(status)) {
        throw new AppError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`, 400);
    }

    // Securely lock the update to the specific Enterprise's Tenant ID
    const order = await Order.findOneAndUpdate(
        { partnerTrackingId: partnerTrackingId, storeId: store._id },
        { 
            $set: { 
                fulfillmentStatus: status,
                notes: notes ? `Partner Note: ${notes}` : undefined
            } 
        },
        { new: true }
    );

    if (!order) {
        throw new AppError('Order not found or does not belong to this Enterprise Tenant', 404);
    }

    // Trigger platform-wide event so the B2C Frontend updates live for the customer
    appEvents.emit('ORDER_UPDATED', { 
        orderId: order._id, 
        status: order.fulfillmentStatus, 
        storeId: store._id 
    });

    return { success: true, message: `Order fulfillment status updated to ${status}` };
};

// --- WEBHOOK: BATCH INVENTORY SYNC ---
// Called hourly or end-of-day by legacy ERPs to push thousands of price/stock changes
exports.batchUpdateInventory = async (request, reply) => {
    const store = await authenticateEnterprise(request);
    const { inventoryUpdates } = request.body; 

    if (!Array.isArray(inventoryUpdates) || inventoryUpdates.length === 0) {
        throw new AppError('inventoryUpdates array is required and cannot be empty', 400);
    }

    // --- NEW: FAT FINGER GUARDRAIL (ANOMALY DETECTION) ---
    const variantIds = inventoryUpdates.map(u => u.variantId);
    const existingInventory = await StoreInventory.find({ storeId: store._id, variantId: { $in: variantIds } }).lean();

    const bulkOps = [];
    let blockedCount = 0;

    for (const update of inventoryUpdates) {
        const currentItem = existingInventory.find(inv => inv.variantId.toString() === update.variantId.toString());
        
        if (currentItem && currentItem.sellingPrice > 0) {
            const dropPercentage = ((currentItem.sellingPrice - Number(update.price)) / currentItem.sellingPrice) * 100;
            
            // If price drops by more than 30%, reject this specific item update to prevent massive platform losses
            if (dropPercentage > 30) {
                console.warn(`[GUARDRAIL] Blocked >30% price drop for ${update.variantId}. Old: Rs ${currentItem.sellingPrice}, New: Rs ${update.price}`);
                blockedCount++;
                continue; // Skip safely without crashing the rest of the batch
            }
        }

        // Construct highly optimized bulk operations to prevent database locking
        bulkOps.push({
            updateOne: {
                filter: { storeId: store._id, variantId: update.variantId },
                update: { 
                    $set: { 
                        stock: Number(update.stock) || 0,
                        sellingPrice: Number(update.price) || 0
                    } 
                }
            }
        });
    }

    if (bulkOps.length > 0) {
        await StoreInventory.bulkWrite(bulkOps);
    }
    
    // Update the health-check timestamp on the Store profile
    await Store.findByIdAndUpdate(store._id, { $set: { "apiIntegration.lastSync": new Date() } });

    // Invalidate caches so the frontend immediately reflects the new Enterprise prices
    const { invalidateProductCache } = require('../services/productCacheService');
    await invalidateProductCache();

    let message = `Successfully synced ${bulkOps.length} inventory items.`;
    if (blockedCount > 0) {
        message += ` WARNING: ${blockedCount} items were blocked by the Anomaly Guardrail due to a price drop exceeding 30%.`;
    }

    return { success: true, message };
};

// --- NEW: PHASE 2 UPSERT INVENTORY CONTROLLER ---
// Cross-references the DailyPick Master Catalog and upserts local inventory.
exports.upsertCatalogAndInventory = async (request, reply) => {
    const store = await authenticateEnterprise(request);
    // Payload expects: { products: [{ sku: "8901234567890", stock: 50, priceRs: 2500 }, ...] }
    const { products } = request.body; 

    if (!Array.isArray(products) || products.length === 0) {
        throw new AppError('products array is required and cannot be empty', 400);
    }

    const bulkOps = [];
    let addedNewCount = 0;
    let updatedCount = 0;
    let notFoundInMasterCount = 0;

    for (const item of products) {
        // Find the global product variant by SKU (Barcode)
        const masterDoc = await MasterProduct.findOne({ "variants.sku": item.sku, isActive: true });
        
        if (!masterDoc) {
            console.warn(`[CATALOG MISSING] SKU ${item.sku} not found in Master Catalog.`);
            notFoundInMasterCount++;
            continue; // Skip to next item, wait for internal team to approve/add the MasterProduct
        }

        // Locate the exact sub-variant ID to attach to the store's local pool
        const variant = masterDoc.variants.find(v => v.sku === item.sku);

        if (variant) {
            bulkOps.push({
                updateOne: {
                    filter: { 
                        storeId: store._id, 
                        masterProductId: masterDoc._id, 
                        variantId: variant._id 
                    },
                    update: {
                        $set: {
                            stock: Number(item.stock) || 0,
                            // Ensure the value is tracked in Rs locally for accurate checkout calculation
                            sellingPrice: Number(item.priceRs) || 0 
                        }
                    },
                    upsert: true // Insert if it's a newly stocked item, update if existing
                }
            });
        }
    }

    if (bulkOps.length > 0) {
        const result = await StoreInventory.bulkWrite(bulkOps);
        updatedCount = result.modifiedCount || 0;
        addedNewCount = result.upsertedCount || 0;
    }

    // Ping the health-check
    await Store.findByIdAndUpdate(store._id, { $set: { "apiIntegration.lastSync": new Date() } });

    // Clear platform cache for B2C users
    const { invalidateProductCache } = require('../services/productCacheService');
    await invalidateProductCache();

    return { 
        success: true, 
        message: `B2B Sync Complete. Updated existing: ${updatedCount}, Onboarded new: ${addedNewCount}. SKUs waiting on Master Catalog approval: ${notFoundInMasterCount}.` 
    };
};

// --- NEW: B2B PROCUREMENT ENGINE ---
exports.createB2BPurchaseOrder = async (request, reply) => {
    const { storeId, masterProductId, variantId, requestedQty, deliveryPincode } = request.body;
    
    // Automatically use the tenantId if authenticated
    const targetStoreId = request.user && request.user.tenantId ? request.user.tenantId : storeId;

    if (!targetStoreId || !masterProductId || !variantId || !requestedQty || !deliveryPincode) {
        throw new AppError('Missing required parameters for B2B procurement', 400);
    }

    // Find Distributors serving this pincode who have this master product in their wholesale catalog
    const distributors = await Distributor.find({ 
        isActive: true,
        serviceablePincodes: deliveryPincode,
        "wholesaleCatalog.masterProductId": masterProductId
    }).lean();

    if (!distributors || distributors.length === 0) {
        throw new AppError('No distributors found serving this product to your pincode', 404);
    }

    // Automatically find the best bulk price
    let bestDistributor = null;
    let lowestPrice = Infinity;

    for (const dist of distributors) {
        const item = dist.wholesaleCatalog.find(c => c.masterProductId.toString() === masterProductId.toString());
        if (item && item.bulkPriceRs < lowestPrice) {
            lowestPrice = item.bulkPriceRs;
            bestDistributor = dist;
        }
    }

    if (!bestDistributor) {
        throw new AppError('Product found in distributor catalog but no valid pricing available', 400);
    }

    // Generate the B2B Purchase Order Draft Data
    const b2bOrderDetails = {
        poNumber: `PO-${Date.now()}`,
        storeId: targetStoreId,
        distributorId: bestDistributor._id,
        distributorName: bestDistributor.name,
        masterProductId: masterProductId,
        variantId: variantId,
        qty: requestedQty,
        unitPriceRs: lowestPrice,
        totalValueRs: lowestPrice * requestedQty,
        status: 'DRAFT'
    };

    return {
        success: true,
        message: 'Optimal B2B Distributor found and Purchase Order drafted.',
        data: b2bOrderDetails
    };
};

// --- NEW: ENTERPRISE STORE-IN-STORE SYNC (MEGA-CHAINS) ---
exports.syncStoreInventory = async (request, reply) => {
    const store = await authenticateEnterprise(request);
    const { syncTimestamp, locationId, items } = request.body;

    if (!items || !Array.isArray(items)) {
        throw new AppError('Items array is required for sync', 400);
    }

    const bulkOps = [];
    for (const item of items) {
        const masterDoc = await MasterProduct.findOne({ "variants.sku": item.sku, isActive: true });
        if (masterDoc) {
            const variant = masterDoc.variants.find(v => v.sku === item.sku);
            if (variant) {
                bulkOps.push({
                    updateOne: {
                        filter: { storeId: store._id, masterProductId: masterDoc._id, variantId: variant._id },
                        update: { $set: { stock: item.stockAvailable, sellingPrice: item.retailPriceRs } },
                        upsert: true
                    }
                });
            }
        }
    }

    if (bulkOps.length > 0) {
        await StoreInventory.bulkWrite(bulkOps);
    }

    await Store.findByIdAndUpdate(store._id, { $set: { "apiIntegration.lastSync": syncTimestamp || new Date() } });

    const { invalidateProductCache } = require('../services/productCacheService');
    await invalidateProductCache();

    return { success: true, message: `Store-in-Store sync completed for ${locationId || 'default'}. Processed ${items.length} items.` };
};

// --- NEW: PHASE 1 ENTERPRISE ORDER FETCH ---
// Allows ERP systems (Reliance, Croma) to programmatically pull their pending/active orders
exports.fetchOrders = async (request, reply) => {
    const store = await authenticateEnterprise(request);
    
    // Allow them to filter by status or date via query params, default to active ones
    const { status, limit = 50, page = 1 } = request.query;
    const query = { storeId: store._id };
    
    if (status) {
        query.fulfillmentStatus = status;
    }

    const skip = (Math.max(1, page) - 1) * limit;

    const orders = await Order.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean();

    const total = await Order.countDocuments(query);

    return {
        success: true,
        message: `Fetched ${orders.length} orders for ${store.name}`,
        data: {
            orders,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit)
            }
        }
    };
};

// ============================================================================
// --- NEW: PHASE 5 ENTERPRISE WEBHOOK HEALTH & RETRY MATRIX ---
// ============================================================================

const mongoose = require('mongoose');
const dlqSchema = new mongoose.Schema({
    storeId: String,
    webhookUrl: String,
    payload: Object,
    error: String,
    createdAt: { type: Date, default: Date.now },
    status: { type: String, default: 'FAILED' }
});

// Create model safely preventing overwrite errors on hot reloads
const WebhookDLQ = mongoose.models.WebhookDLQ || mongoose.model('WebhookDLQ', dlqSchema);

exports.logFailedWebhook = async (storeId, webhookUrl, payload, errorMsg) => {
    try {
        await WebhookDLQ.create({ storeId, webhookUrl, payload, error: errorMsg });
    } catch (e) {
        console.error("Failed to write to Dead Letter Queue:", e.message);
    }
};

exports.getFailedWebhooks = async (request, reply) => {
    if (!request.user || request.user.role !== 'SuperAdmin') {
        throw new AppError('Unauthorized: HQ access required for System Health', 403);
    }
    const failures = await WebhookDLQ.find({ status: 'FAILED' }).sort('-createdAt').limit(50);
    return { success: true, data: failures };
};

exports.retryFailedWebhook = async (request, reply) => {
    if (!request.user || request.user.role !== 'SuperAdmin') {
        throw new AppError('Unauthorized', 403);
    }
    const { id } = request.params;
    const dlq = await WebhookDLQ.findById(id);
    
    if (!dlq) throw new AppError('Failed log not found in Dead Letter Queue', 404);
    
    try {
        const axios = require('axios');
        // Standard payload retry 
        await axios.post(dlq.webhookUrl, dlq.payload, { timeout: 10000 });
        
        dlq.status = 'RESOLVED';
        await dlq.save();
        
        return { success: true, message: 'Webhook retry successful!' };
    } catch (e) {
        dlq.error = e.message;
        await dlq.save();
        return { success: false, message: 'Retry failed again: ' + e.message };
    }
};

// ============================================================================
// --- NEW: PHASE 7 ENTERPRISE API RATE LIMITING & BACKGROUND QUEUE ---
// ============================================================================
const originalBatchUpdateInventoryPhase7 = exports.batchUpdateInventory;

exports.batchUpdateInventory = async (request, reply) => {
    const { inventoryUpdates } = request.body;
    
    // If the ERP pushes an absolutely massive payload, queue it safely
    if (inventoryUpdates && inventoryUpdates.length > 500) {
        setImmediate(async () => {
            try {
                const chunkSize = 500;
                for (let i = 0; i < inventoryUpdates.length; i += chunkSize) {
                    const chunk = inventoryUpdates.slice(i, i + chunkSize);
                    // Synthesize a chunked request
                    const chunkReq = { ...request, body: { inventoryUpdates: chunk } };
                    await originalBatchUpdateInventoryPhase7(chunkReq, reply);
                    
                    // 1-second breather for the Mongo Connection Pool
                    await new Promise(res => setTimeout(res, 1000));
                }
                console.log(`[BACKGROUND QUEUE] Successfully processed ${inventoryUpdates.length} massive Enterprise items.`);
            } catch(e) {
                console.error("[BACKGROUND QUEUE ERROR] Batch Update failed:", e.message);
            }
        });
        
        // Return 202 Accepted immediately so the Enterprise ERP doesn't timeout
        reply.code(202);
        return { success: true, message: `Payload too large for synchronous execution. Queued ${inventoryUpdates.length} items for safe background batch processing.` };
    }
    
    // Normal synchronous processing for standard payloads
    return await originalBatchUpdateInventoryPhase7(request, reply);
};
