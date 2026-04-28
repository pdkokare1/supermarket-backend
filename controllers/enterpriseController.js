/* controllers/enterpriseController.js */
'use strict';

const Order = require('../models/Order');
const Store = require('../models/Store');
const StoreInventory = require('../models/StoreInventory');
const MasterProduct = require('../models/MasterProduct'); // --- ADDED FOR PHASE 2 ---
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
// Cross-references the Gamut Master Catalog and upserts local inventory.
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
