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
// --- NEW: FINANCIAL SETTLEMENT HELPER ---
// ==========================================
async function generateSettlement(session, order, storeId) {
    if (!storeId) return;
    const store = await Store.findById(storeId).session(session).lean();
    if (!store) return;

    const commissionRate = store.financials?.commissionRate || 5.0; // Default 5% platform cut
    const platformCommission = (order.totalAmount * commissionRate) / 100;
    const gatewayFee = order.paymentMethod === 'Online' ? (order.totalAmount * 0.02) : 0; // standard 2% Razorpay processing fee
    const netPayoutToStore = order.totalAmount - platformCommission - gatewayFee;

    const settlement = new Settlement({
        storeId: store._id,
        orderId: order._id,
        orderNumber: order.orderNumber,
        totalOrderValue: order.totalAmount,
        platformCommission,
        gatewayFee,
        netPayoutToStore,
        status: 'Pending'
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
            await generateSettlement(session, newOrder, storeId); // NEW: Lock the ledger
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
        let storeCache = null; // Store locally so we can access it outside the coreLogic scope
        
        const coreLogic = async (session) => {
            
            // --- STRICT AGGREGATOR TENANT VALIDATION ---
            if (!storeId) throw new AppError('Tenant Isolation Error: Target store must be specified for checkout', 400);

            const store = await Store.findById(storeId).session(session).lean();
            if (!store) throw new AppError('Target store not found', 404);
            
            storeCache = store;

            let calculatedTotal = 0;
            const validatedItems = [];

            // --- ANTI-TAMPER & ISOLATED CART ENFORCER ---
            for (const item of items) {
                // We completely ignore the frontend pricing and query the local store's actual database row
                const localStock = await StoreInventory.findOne({
                    storeId: storeId,
                    masterProductId: item.productId, // Legacy payload mapping
                    variantId: item.variantId
                }).session(session).lean();

                if (!localStock) {
                    throw new AppError(`Isolated Cart Error: An item in your cart does not belong to the selected store. Please clear cart and checkout from one store at a time.`, 400);
                }

                calculatedTotal += (localStock.sellingPrice * item.qty);
                
                validatedItems.push({
                    ...item,
                    masterProductId: item.productId,
                    storeInventoryId: localStock._id,
                    price: localStock.sellingPrice // Lock in the strictly verified price
                });
            }

            // --- SMART FULFILLMENT ROUTING ---
            let assignedFulfillmentType = 'PICKUP';
            if (deliveryType && deliveryType.toLowerCase().includes('delivery') || deliveryType === 'Instant') {
                if (store.fulfillmentOptions && store.fulfillmentOptions.includes('STORE_DELIVERY')) {
                    assignedFulfillmentType = 'STORE_DELIVERY'; // Send to Enterprise API
                } else {
                    assignedFulfillmentType = 'PLATFORM_DELIVERY'; // Send to our Rider Fleet
                }
            }

            const orderData = { 
                notes: notes || '', 
                customerName, 
                customerPhone, 
                deliveryAddress, 
                totalAmount: calculatedTotal, // Security Fix: Overriding frontend payload entirely
                paymentMethod: paymentMethod || 'Cash on Delivery', 
                deliveryType: deliveryType || 'Instant', 
                scheduleTime: scheduleTime || 'ASAP',
                fulfillmentType: assignedFulfillmentType,
                fulfillmentStatus: 'Pending'
            };
            
            // OPTIMIZATION: Customer profile update and Order Finalization are completely independent. 
            const [_, newOrder] = await Promise.all([
                customerService.processOnlineCheckoutProfile(customerPhone, customerName, calculatedTotal, paymentMethod, session),
                finalizeAndSaveOrder(session, validatedItems, storeId, 'ORD', orderData)
            ]);

            await generateSettlement(session, newOrder, storeId); // NEW: Lock the ledger

            return newOrder;
        };

        const newOrder = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        appEvents.emit('NEW_ORDER', { order: newOrder, storeId, source: 'Online' });

        // --- TRIGGER ENTERPRISE BRIDGE ---
        if (storeCache && newOrder.fulfillmentType === 'STORE_DELIVERY') {
            dispatchEnterpriseWebhook(storeCache, newOrder);
        }

        const msg = `DailyPick Order Received! 🛒\nOrder ID: ${newOrder.orderNumber}\nTotal: Rs ${newOrder.totalAmount}\nDelivery: ${scheduleTime || 'ASAP'}\nThanks for shopping!`;
        notificationService.sendWhatsAppMessage(customerPhone, msg).catch(() => {}); 

        return newOrder;
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
            await generateSettlement(session, newOrder, storeId); // NEW: Lock the ledger
            
            return newOrder;
        };

        const newOrder = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        appEvents.emit('NEW_ORDER', { order: newOrder, storeId, source: 'POS' });

        const loyaltyMsg = pointsRedeemed > 0 ? ` Points Redeemed: ${pointsRedeemed}.` : '';
        const msg = `Thank you for shopping at DailyPick! 🛒\nOrder: ${newOrder.orderNumber}\nTotal: Rs ${totalAmount}\n${loyaltyMsg}\nVisit again!`;
        notificationService.sendWhatsAppMessage(customerPhone, msg).catch(() => {}); 

        return newOrder;
    });
};
