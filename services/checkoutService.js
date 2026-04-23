/* services/checkoutService.js */

const crypto = require('crypto'); // ENTERPRISE FIX: Native crypto for unique idempotency lock tracking
const mongoose = require('mongoose');
const Order = require('../models/Order');
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
    const inventoryCheck = await inventoryService.deductInventory(items, storeId, session);
    if (!inventoryCheck.success) throw new AppError(inventoryCheck.message, 400);

    const seqNumber = await generateOrderSequence(session);
    const orderNumber = `${orderPrefix}-${seqNumber}`;
    const dateString = new Date().toISOString().split('T')[0];

    const newOrder = new Order({ orderNumber, dateString, storeId: storeId || null, items, ...orderData });
    await newOrder.save({ session });
    await cacheUtils.deleteKey('orders:analytics');

    return newOrder;
}

// ==========================================
// --- CHECKOUT OPERATIONS ---
// ==========================================

exports.processExternalCheckout = async (payload, externalSession = null) => {
    return await withIdempotency(payload.idempotencyKey, async () => {
        
        const coreLogic = async (session) => {
            const { source, externalOrderId, customerName, customerPhone, deliveryAddress, items, totalAmount, paymentMethod, notes, storeId } = payload;
            const orderPrefix = `EXT-${source.toUpperCase().substring(0, 3)}`;
            const formattedNotes = `[${source.toUpperCase()}] Ext ID: ${externalOrderId || 'N/A'}. ${notes || ''}`;
            const orderData = { notes: formattedNotes, customerName: customerName || `${source} Customer`, customerPhone: customerPhone || '', deliveryAddress: deliveryAddress || `${source} Pickup`, totalAmount, paymentMethod: paymentMethod || 'Prepaid External', deliveryType: 'Instant', status: 'Order Placed' };
            return await finalizeAndSaveOrder(session, items, storeId, orderPrefix, orderData);
        };

        const newOrder = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        appEvents.emit('NEW_ORDER', { order: newOrder, storeId: payload.storeId, source: payload.source });
        return newOrder;
    });
};

exports.processOnlineCheckout = async (payload, externalSession = null) => {
    return await withIdempotency(payload.idempotencyKey, async () => {
        const { customerName, customerPhone, deliveryAddress, items, totalAmount, deliveryType, scheduleTime, paymentMethod, notes, storeId } = payload;
        
        const coreLogic = async (session) => {
            
            await customerService.processOnlineCheckoutProfile(customerPhone, customerName, totalAmount, paymentMethod, session);

            const orderData = { notes: notes || '', customerName, customerPhone, deliveryAddress, totalAmount, paymentMethod: paymentMethod || 'Cash on Delivery', deliveryType: deliveryType || 'Instant', scheduleTime: scheduleTime || 'ASAP' };
            return await finalizeAndSaveOrder(session, items, storeId, 'ORD', orderData);
        };

        const newOrder = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        appEvents.emit('NEW_ORDER', { order: newOrder, storeId, source: 'Online' });

        const msg = `DailyPick Order Received! 🛒\nOrder ID: ${newOrder.orderNumber}\nTotal: Rs ${totalAmount}\nDelivery: ${scheduleTime || 'ASAP'}\nThanks for shopping!`;
        notificationService.sendWhatsAppMessage(customerPhone, msg).catch(() => {}); 

        return newOrder;
    });
};

exports.processPosCheckout = async (payload, externalSession = null) => {
    return await withIdempotency(payload.idempotencyKey, async () => {
        const { customerPhone, items, totalAmount, taxAmount, discountAmount, paymentMethod, splitDetails, pointsRedeemed, notes, storeId, registerId } = payload;
        
        const coreLogic = async (session) => {
            let finalCustomerName = 'Walk-in Guest';

            if (customerPhone) {
                finalCustomerName = await customerService.processPosCheckoutProfile(customerPhone, totalAmount, paymentMethod, pointsRedeemed, session);
            }

            const orderData = { registerId: registerId || null, notes: notes || '', customerName: finalCustomerName, customerPhone: customerPhone || '', deliveryAddress: 'In-Store Purchase', totalAmount, taxAmount: taxAmount || 0, discountAmount: discountAmount || 0, paymentMethod, splitDetails: splitDetails || { cash: 0, upi: 0 }, deliveryType: 'Instant', status: 'Completed' };
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
