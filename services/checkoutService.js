/* services/checkoutService.js */

const crypto = require('crypto'); // ENTERPRISE FIX: Native crypto for unique idempotency lock tracking
const mongoose = require('mongoose');
const axios = require('axios'); // For outbound enterprise webhooks
const Order = require('../models/Order');
const Store = require('../models/Store'); // For routing logic
const StoreInventory = require('../models/StoreInventory'); // For anti-tampering
const Settlement = require('../models/Settlement'); // NEW: For Financial Ledger Automation
const customerService = require('./customerService'); 
const inventoryService = require('./inventoryService'); 
const notificationService = require('./notificationService'); 
const { withTransaction } = require('../utils/dbUtils');
const AppError = require('../utils/AppError');
const cacheUtils = require('../utils/cacheUtils');
const appEvents = require('../utils/eventEmitter'); 

// ==========================================
// --- ENTERPRISE IDEMPOTENCY ENGINE ---
// ==========================================

async function withIdempotency(idempotencyKey, executeCheckoutTask) {
    const redisClient = cacheUtils.getClient();
    
    if (idempotencyKey && redisClient) {
        const resultKey = `idem:checkout:${idempotencyKey}`;
        const lockKey = `idem:lock:${idempotencyKey}`;
        
        // ENTERPRISE FIX: Unique UUID to guarantee a thread only deletes its own lock
        const lockValue = crypto.randomUUID(); 

        const cachedResult = await redisClient.get(resultKey);
        if (cachedResult) {
            console.log(`[IDEMPOTENCY] Caught duplicate checkout request for key: ${idempotencyKey}. Returning cached success.`);
            return JSON.parse(cachedResult); 
        }

        const acquiredLock = await redisClient.set(lockKey, lockValue, 'NX', 'EX', 30);
        if (!acquiredLock) {
            throw new AppError('Concurrent checkout processing detected. Please wait.', 409);
        }

        try {
            const result = await executeCheckoutTask();
            
            await redisClient.set(resultKey, JSON.stringify(result), 'EX', 86400);
            
            return result;
        } finally {
            // ENTERPRISE FIX: Atomic Lua script ensures lock is only deleted if the UUID matches.
            // Prevents long-running checkouts from accidentally deleting locks acquired by subsequent requests.
            const script = `
                if redis.call("get", KEYS[1]) == ARGV[1] then
                    return redis.call("del", KEYS[1])
                else
                    return 0
                end
            `;
            await redisClient.eval(script, 1, lockKey, lockValue);
        }
    } else {
        return await executeCheckoutTask();
    }
}

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

async function generateOrderSequence(session) {
    // OPTIMIZATION: Added { lean: true } to avoid building a heavy Mongoose document for a simple numeric counter.
    const counter = await mongoose.model('OrderCounter').findByIdAndUpdate(
        { _id: 'orderId' },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, session, lean: true }
    );
    return counter.seq;
}

async function finalizeAndSaveOrder(session, items, storeId, orderPrefix, orderData) {
    // OPTIMIZATION: Parallelize independent DB calls to shorten transaction lock duration.
    const [inventoryCheck, seqNumber] = await Promise.all([
        inventoryService.deductInventory(items, storeId, session),
        generateOrderSequence(session)
    ]);

    // ENTERPRISE FIX: Propagate 409 Conflict precisely if the inventory check hit a race condition
    if (!inventoryCheck.success) throw new AppError(inventoryCheck.message, 409);

    const orderNumber = `${orderPrefix}-${seqNumber}`;
    const dateString = new Date().toISOString().split('T')[0];

    const newOrder = new Order({ orderNumber, dateString, storeId: storeId || null, items, ...orderData });
    
    // OPTIMIZATION: Run the DB save and the Redis cache invalidation concurrently.
    await Promise.all([
        newOrder.save({ session }),
        cacheUtils.deleteKey('orders:analytics')
    ]);

    return newOrder;
}

// --- B2B OMNICHANNEL WEBHOOK DISPATCHER ---
async function dispatchEnterpriseWebhook(store, order) {
    if (!store.apiIntegration || !store.apiIntegration.webhookUrl) return;

    try {
        // Strip sensitive internal data before sending to partner
        const payload = {
            platformOrderId: order._id,
            orderNumber: order.orderNumber,
            customerName: order.customerName,
            customerPhone: order.customerPhone,
            deliveryAddress: order.deliveryAddress,
            totalAmount: order.totalAmount,
            paymentMethod: order.paymentMethod,
            notes: order.notes,
            items: order.items.map(i => ({
                variantId: i.variantId,
                qty: i.qty,
                price: i.price
            }))
        };

        // Fire and forget. We don't await this so it doesn't block the customer checkout flow.
        axios.post(store.apiIntegration.webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'x-gamut-signature': store.apiIntegration.apiSecretKey // Simple auth for the partner to verify us
            },
            timeout: 5000 // Don't hang forever
        }).catch(err => {
            console.error(`[WEBHOOK FAILED] Failed to push order to Enterprise Store ${store.name}:`, err.message);
        });

    } catch (error) {
        console.error(`[WEBHOOK ERROR] Internal error preparing webhook for store ${store.name}:`, error);
    }
}

// ==========================================
// --- PHASE 3: DYNAMIC SETTLEMENT CALCULATOR ---
// ==========================================
async function generateSettlement(session, order, storeId) {
    if (!storeId) return;
    const store = await Store.findById(storeId).session(session).lean();
    if (!store) return;

    // --- PHASE 3: DYNAMIC COMMERCIAL TERMS ---
    // Reads Gamut's polymorphic contracts to ensure fair and accurate payouts
    const commType = store.commercialTerms?.commissionType || 'PERCENTAGE';
    const commValue = store.commercialTerms?.commissionValue || 5.0; // Fallback to legacy

    let platformCommission = 0;
    if (commType === 'PERCENTAGE') {
        platformCommission = (order.totalAmount * commValue) / 100;
    } else if (commType === 'FLAT_FEE') {
        platformCommission = commValue; // Strict Rs flat fee per checkout
    } else if (commType === 'SUBSCRIPTION') {
        platformCommission = 0; // SaaS clients pay 0 Rs commission per transaction
    }

    const gatewayFee = order.paymentMethod === 'Online' ? (order.totalAmount * 0.02) : 0; // standard 2% gateway processing
    const netPayoutToStore = order.totalAmount - platformCommission - gatewayFee;

    const settlement = new Settlement({
        storeId: store._id,
        orderId: order._id,
        orderNumber: order.orderNumber,
        totalOrderValue: order.totalAmount,
        platformCommission,
        gatewayFee,
        netPayoutToStore,
        status: 'Pending',
        commissionTypeApplied: commType
    });
    
    await settlement.save({ session });
}

// ==========================================
// --- CHECKOUT OPERATIONS ---
// ==========================================

exports.processExternalCheckout = async (payload, externalSession = null) => {
    return await withIdempotency(payload.idempotencyKey, async () => {
        
        const coreLogic = async (session) => {
            const { source, externalOrderId, customerName, customerPhone, deliveryAddress, items, totalAmount, paymentMethod, notes, storeId } = payload;
            
            // ENTERPRISE FIX: Null-pointer prevention for third-party payloads missing the 'source' field
            const safeSource = source || 'API';
            const orderPrefix = `EXT-${safeSource.toUpperCase().substring(0, 3)}`;
            const formattedNotes = `[${safeSource.toUpperCase()}] Ext ID: ${externalOrderId || 'N/A'}. ${notes || ''}`;
            const orderData = { notes: formattedNotes, customerName: customerName || `${safeSource} Customer`, customerPhone: customerPhone || '', deliveryAddress: deliveryAddress || `${safeSource} Pickup`, totalAmount, paymentMethod: paymentMethod || 'Prepaid External', deliveryType: 'Instant', status: 'Order Placed' };
            
            const newOrder = await finalizeAndSaveOrder(session, items, storeId, orderPrefix, orderData);
            await generateSettlement(session, newOrder, storeId); // Phase 3 ledger
            return newOrder;
        };

        const newOrder = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        appEvents.emit('NEW_ORDER', { order: newOrder, storeId: payload.storeId, source: payload.source || 'API' });
        return newOrder;
    });
};

exports.processOnlineCheckout = async (payload, externalSession = null) => {
    return await withIdempotency(payload.idempotencyKey, async () => {
        const { customerName, customerPhone, deliveryAddress, items, deliveryType, scheduleTime, paymentMethod, notes, storeId } = payload;
        
        // Cache external store references for webhooks after the transaction block completes
        const storeCaches = [];
        let totalMasterCartRs = 0;
        
        const coreLogic = async (session) => {
            // --- PHASE 3: SMART CART SPLITTING ---
            // Group items by their specific storeId. Fallbacks to payload.storeId for legacy single-store checkouts.
            const cartGroups = {};
            let requiresSplit = false;

            for (const item of items) {
                const targetStoreId = item.storeId || storeId;
                if (!targetStoreId) throw new AppError('Tenant Isolation Error: Target store must be specified for all items', 400);
                
                if (targetStoreId.toString() !== (storeId || '').toString()) {
                    requiresSplit = true; // Omni-channel multiple stores detected in the single payload
                }

                if (!cartGroups[targetStoreId]) cartGroups[targetStoreId] = [];
                cartGroups[targetStoreId].push(item);
            }

            const generatedOrders = [];
            // Generates a master cart ID to link split sub-orders together for the B2C frontend
            const splitShipmentGroupId = requiresSplit ? crypto.randomUUID() : null;
            let profileUpdated = false;

            for (const [currentStoreId, storeItems] of Object.entries(cartGroups)) {
                const store = await Store.findById(currentStoreId).session(session).lean();
                if (!store) throw new AppError(`Target store ${currentStoreId} not found`, 404);
                
                storeCaches.push(store);

                let calculatedTotal = 0;
                const validatedItems = [];

                // --- ANTI-TAMPER & ISOLATED CART ENFORCER ---
                for (const item of storeItems) {
                    const localStock = await StoreInventory.findOne({
                        storeId: currentStoreId,
                        masterProductId: item.productId,
                        variantId: item.variantId
                    }).session(session).lean();

                    if (!localStock) {
                        throw new AppError(`Isolated Cart Error: An item does not belong to the store ${store.name}.`, 400);
                    }

                    calculatedTotal += (localStock.sellingPrice * item.qty);
                    
                    validatedItems.push({
                        ...item,
                        masterProductId: item.productId,
                        storeInventoryId: localStock._id,
                        price: localStock.sellingPrice
                    });
                }

                totalMasterCartRs += calculatedTotal;

                // --- SMART FULFILLMENT ROUTING ---
                let assignedFulfillmentType = 'PICKUP';
                if (deliveryType && deliveryType.toLowerCase().includes('delivery') || deliveryType === 'Instant') {
                    if (store.fulfillmentOptions && store.fulfillmentOptions.includes('STORE_DELIVERY')) {
                        assignedFulfillmentType = 'STORE_DELIVERY'; // Send to Partner API
                    } else {
                        assignedFulfillmentType = 'PLATFORM_DELIVERY'; // Platform Fleet
                    }
                }

                const orderData = { 
                    notes: notes || '', 
                    customerName, 
                    customerPhone, 
                    deliveryAddress, 
                    totalAmount: calculatedTotal, 
                    paymentMethod: paymentMethod || 'Cash on Delivery', 
                    deliveryType: deliveryType || 'Instant', 
                    scheduleTime: scheduleTime || 'ASAP',
                    fulfillmentType: assignedFulfillmentType,
                    fulfillmentStatus: 'Pending',
                    splitShipmentGroupId 
                };
                
                // Ensure customer profile is only processed once per cart to avoid DB lock collisions
                if (!profileUpdated) {
                    await customerService.processOnlineCheckoutProfile(customerPhone, customerName, totalMasterCartRs, paymentMethod, session);
                    profileUpdated = true;
                }

                const newOrder = await finalizeAndSaveOrder(session, validatedItems, currentStoreId, 'ORD', orderData);
                await generateSettlement(session, newOrder, currentStoreId); // Phase 3 dynamic ledger

                generatedOrders.push(newOrder);
            }

            // Optional: Tag all orders with the total master cart amount if it was split
            if (requiresSplit) {
                for (let o of generatedOrders) {
                    o.masterCartTotalRs = totalMasterCartRs;
                    await o.save({ session });
                }
            }

            return generatedOrders;
        };

        const generatedOrders = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        // --- POST-CHECKOUT TRIGGERS ---
        for (const newOrder of generatedOrders) {
            const storeCache = storeCaches.find(s => s._id.toString() === newOrder.storeId.toString());

            appEvents.emit('NEW_ORDER', { order: newOrder, storeId: newOrder.storeId, source: 'Online' });

            if (storeCache && newOrder.fulfillmentType === 'STORE_DELIVERY') {
                dispatchEnterpriseWebhook(storeCache, newOrder);
            }
        }

        // Send a single combined notification to the customer protecting their unified experience
        if (generatedOrders.length > 0) {
            const orderReference = generatedOrders.length > 1 ? `Omni-Cart (${generatedOrders.length} Shipments)` : generatedOrders[0].orderNumber;
            const msg = `The Gamut Order Received! 🛒\nReference: ${orderReference}\nTotal: Rs ${totalMasterCartRs}\nThanks for shopping!`;
            notificationService.sendWhatsAppMessage(customerPhone, msg).catch(() => {}); 
        }

        // Maintain backward compatibility for standard frontend responses
        return generatedOrders.length === 1 ? generatedOrders[0] : generatedOrders;
    });
};

exports.processPosCheckout = async (payload, externalSession = null) => {
    return await withIdempotency(payload.idempotencyKey, async () => {
        const { customerPhone, items, totalAmount, taxAmount, discountAmount, paymentMethod, splitDetails, pointsRedeemed, notes, storeId, registerId } = payload;
        
        const coreLogic = async (session) => {
            let finalCustomerName = 'Walk-in Guest';

            // NOTE: Cannot parallelize this step because finalCustomerName is required dynamically for the order payload below.
            if (customerPhone) {
                finalCustomerName = await customerService.processPosCheckoutProfile(customerPhone, totalAmount, paymentMethod, pointsRedeemed, session);
            }

            // POS inherently accepts the totalAmount payload to allow cashiers to do manual complex overrides and discounts on the floor
            const orderData = { registerId: registerId || null, notes: notes || '', customerName: finalCustomerName, customerPhone: customerPhone || '', deliveryAddress: 'In-Store Purchase', totalAmount, taxAmount: taxAmount || 0, discountAmount: discountAmount || 0, paymentMethod, splitDetails: splitDetails || { cash: 0, upi: 0 }, deliveryType: 'Instant', status: 'Completed', fulfillmentType: 'PICKUP', fulfillmentStatus: 'Delivered' };
            
            const newOrder = await finalizeAndSaveOrder(session, items, storeId, 'ORD', orderData);
            await generateSettlement(session, newOrder, storeId); // Phase 3 dynamic ledger
            
            return newOrder;
        };

        const newOrder = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        appEvents.emit('NEW_ORDER', { order: newOrder, storeId, source: 'POS' });

        const loyaltyMsg = pointsRedeemed > 0 ? ` Points Redeemed: ${pointsRedeemed}.` : '';
        const msg = `Thank you for shopping at The Gamut! 🛒\nOrder: ${newOrder.orderNumber}\nTotal: Rs ${totalAmount}\n${loyaltyMsg}\nVisit again!`;
        notificationService.sendWhatsAppMessage(customerPhone, msg).catch(() => {}); 

        return newOrder;
    });
};
