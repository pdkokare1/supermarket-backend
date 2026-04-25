/* services/checkoutService.js */

const crypto = require('crypto'); // ENTERPRISE FIX: Native crypto for unique idempotency lock tracking
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Store = require('../models/Store'); // NEW: For routing logic
const StoreInventory = require('../models/StoreInventory'); // NEW: For anti-tampering
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
            
            return await finalizeAndSaveOrder(session, items, storeId, orderPrefix, orderData);
        };

        const newOrder = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        appEvents.emit('NEW_ORDER', { order: newOrder, storeId: payload.storeId, source: payload.source || 'API' });
        return newOrder;
    });
};

exports.processOnlineCheckout = async (payload, externalSession = null) => {
    return await withIdempotency(payload.idempotencyKey, async () => {
        const { customerName, customerPhone, deliveryAddress, items, deliveryType, scheduleTime, paymentMethod, notes, storeId } = payload;
        
        const coreLogic = async (session) => {
            
            // --- NEW: STRICT AGGREGATOR TENANT VALIDATION ---
            if (!storeId) throw new AppError('Tenant Isolation Error: Target store must be specified for checkout', 400);

            const store = await Store.findById(storeId).session(session).lean();
            if (!store) throw new AppError('Target store not found', 404);

            let calculatedTotal = 0;
            const validatedItems = [];

            // --- NEW: ANTI-TAMPER & ISOLATED CART ENFORCER ---
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

            // --- NEW: SMART FULFILLMENT ROUTING ---
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

            return newOrder;
        };

        const newOrder = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        appEvents.emit('NEW_ORDER', { order: newOrder, storeId, source: 'Online' });

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
            return await finalizeAndSaveOrder(session, items, storeId, 'ORD', orderData);
        };

        const newOrder = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        appEvents.emit('NEW_ORDER', { order: newOrder, storeId, source: 'POS' });

        const loyaltyMsg = pointsRedeemed > 0 ? ` Points Redeemed: ${pointsRedeemed}.` : '';
        const msg = `Thank you for shopping at DailyPick! 🛒\nOrder: ${newOrder.orderNumber}\nTotal: Rs ${totalAmount}\n${loyaltyMsg}\nVisit again!`;
        notificationService.sendWhatsAppMessage(customerPhone, msg).catch(() => {}); 

        return newOrder;
    });
};
