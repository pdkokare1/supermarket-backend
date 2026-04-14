/* services/checkoutService.js */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Customer = require('../models/Customer');
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
    
    // Step 1: Intercept Duplicate Request
    if (idempotencyKey && redisClient) {
        const cachedResult = await redisClient.get(`idem:checkout:${idempotencyKey}`);
        if (cachedResult) {
            console.log(`[IDEMPOTENCY] Caught duplicate checkout request for key: ${idempotencyKey}. Returning cached success.`);
            return JSON.parse(cachedResult); 
        }
    }
    
    // Step 2: Execute Standard Logic if not a duplicate
    const result = await executeCheckoutTask();
    
    // Step 3: Cache the successful result for 24 hours (86400 seconds)
    if (idempotencyKey && redisClient) {
        await redisClient.set(`idem:checkout:${idempotencyKey}`, JSON.stringify(result), 'EX', 86400);
    }
    
    return result;
}

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

async function generateOrderSequence(session) {
    const counter = await mongoose.model('OrderCounter').findByIdAndUpdate(
        { _id: 'orderId' },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, session }
    );
    return counter.seq;
}

function validateAndApplyPayLater(custProfile, amount) {
    if (!custProfile || !custProfile.isCreditEnabled) {
        throw new AppError('Pay Later is not enabled for this account.', 400);
    }
    if ((custProfile.creditUsed + amount) > custProfile.creditLimit) {
        throw new AppError(`Credit limit exceeded. Available credit: Rs ${custProfile.creditLimit - custProfile.creditUsed}`, 400);
    }
    custProfile.creditUsed += amount;
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

// OPTIMIZATION: Added externalSession to prevent nested transaction deadlocks when called by Controller
exports.processExternalCheckout = async (payload, externalSession = null) => {
    return await withIdempotency(payload.idempotencyKey, async () => {
        
        const coreLogic = async (session) => {
            const { source, externalOrderId, customerName, customerPhone, deliveryAddress, items, totalAmount, paymentMethod, notes, storeId } = payload;
            const orderPrefix = `EXT-${source.toUpperCase().substring(0, 3)}`;
            const formattedNotes = `[${source.toUpperCase()}] Ext ID: ${externalOrderId || 'N/A'}. ${notes || ''}`;
            const orderData = { notes: formattedNotes, customerName: customerName || `${source} Customer`, customerPhone: customerPhone || '', deliveryAddress: deliveryAddress || `${source} Pickup`, totalAmount, paymentMethod: paymentMethod || 'Prepaid External', deliveryType: 'Instant', status: 'Order Placed' };
            return await finalizeAndSaveOrder(session, items, storeId, orderPrefix, orderData);
        };

        // OPTIMIZATION: Seamlessly hook into outer controller session or create a new one if standalone
        const newOrder = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        appEvents.emit('NEW_ORDER', { order: newOrder, storeId: payload.storeId, source: payload.source });
        return newOrder;
    });
};

// OPTIMIZATION: Added externalSession to prevent nested transaction deadlocks when called by Controller
exports.processOnlineCheckout = async (payload, externalSession = null) => {
    return await withIdempotency(payload.idempotencyKey, async () => {
        const { customerName, customerPhone, deliveryAddress, items, totalAmount, deliveryType, scheduleTime, paymentMethod, notes, storeId } = payload;
        
        const coreLogic = async (session) => {
            
            // DEPRECATION CONSULTATION: Read-then-write creates race conditions causing Duplicate Key crashes.
            /*
            let custProfile = await Customer.findOne({ phone: customerPhone })
                .select('name phone loyaltyPoints creditUsed creditLimit isCreditEnabled')
                .session(session);

            if (paymentMethod === 'Pay Later') validateAndApplyPayLater(custProfile, totalAmount);

            if (!custProfile) {
                custProfile = new Customer({ phone: customerPhone, name: customerName });
                if (paymentMethod === 'Pay Later') throw new AppError('Pay Later is not enabled for this new account.', 400);
            } else if (custProfile.name !== customerName) {
                custProfile.name = customerName; 
            }
            await custProfile.save({ session });
            */

            // OPTIMIZED: Atomic Upsert to eliminate concurrency collisions
            let custProfile = await Customer.findOneAndUpdate(
                { phone: customerPhone },
                { 
                    $setOnInsert: { phone: customerPhone, loyaltyPoints: 0 },
                    $set: { name: customerName } 
                },
                { new: true, upsert: true, session }
            ).select('name phone loyaltyPoints creditUsed creditLimit isCreditEnabled');

            if (paymentMethod === 'Pay Later') validateAndApplyPayLater(custProfile, totalAmount);
            await custProfile.save({ session }); 

            appEvents.emit('CUSTOMER_UPDATED', { phone: custProfile.phone });

            const orderData = { notes: notes || '', customerName, customerPhone, deliveryAddress, totalAmount, paymentMethod: paymentMethod || 'Cash on Delivery', deliveryType: deliveryType || 'Instant', scheduleTime: scheduleTime || 'ASAP' };
            return await finalizeAndSaveOrder(session, items, storeId, 'ORD', orderData);
        };

        // OPTIMIZATION: Seamlessly hook into outer controller session or create a new one if standalone
        const newOrder = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        appEvents.emit('NEW_ORDER', { order: newOrder, storeId, source: 'Online' });

        const msg = `DailyPick Order Received! 🛒\nOrder ID: ${newOrder.orderNumber}\nTotal: Rs ${totalAmount}\nDelivery: ${scheduleTime || 'ASAP'}\nThanks for shopping!`;
        notificationService.sendWhatsAppMessage(customerPhone, msg).catch(() => {}); 

        return newOrder;
    });
};

// OPTIMIZATION: Added externalSession to prevent nested transaction deadlocks when called by Controller
exports.processPosCheckout = async (payload, externalSession = null) => {
    return await withIdempotency(payload.idempotencyKey, async () => {
        const { customerPhone, items, totalAmount, taxAmount, discountAmount, paymentMethod, splitDetails, pointsRedeemed, notes, storeId, registerId } = payload;
        
        const coreLogic = async (session) => {
            let finalCustomerName = 'Walk-in Guest';

            if (customerPhone) {
                // OPTIMIZED: Applied the same atomic protection to POS checkout
                let custProfile = await Customer.findOneAndUpdate(
                    { phone: customerPhone },
                    { $setOnInsert: { phone: customerPhone, name: 'In-Store Customer', loyaltyPoints: 0 } },
                    { new: true, upsert: true, session }
                ).select('name phone loyaltyPoints creditUsed creditLimit isCreditEnabled');
                    
                finalCustomerName = custProfile.name;
                
                if (pointsRedeemed && pointsRedeemed > 0) {
                    custProfile.loyaltyPoints = Math.max(0, (custProfile.loyaltyPoints || 0) - pointsRedeemed);
                }
                custProfile.loyaltyPoints = (custProfile.loyaltyPoints || 0) + Math.floor(totalAmount / 100);
                
                if (paymentMethod === 'Pay Later') validateAndApplyPayLater(custProfile, totalAmount);
                await custProfile.save({ session });
                
                appEvents.emit('CUSTOMER_UPDATED', { phone: custProfile.phone });
            }

            const orderData = { registerId: registerId || null, notes: notes || '', customerName: finalCustomerName, customerPhone: customerPhone || '', deliveryAddress: 'In-Store Purchase', totalAmount, taxAmount: taxAmount || 0, discountAmount: discountAmount || 0, paymentMethod, splitDetails: splitDetails || { cash: 0, upi: 0 }, deliveryType: 'Instant', status: 'Completed' };
            return await finalizeAndSaveOrder(session, items, storeId, 'ORD', orderData);
        };

        // OPTIMIZATION: Seamlessly hook into outer controller session or create a new one if standalone
        const newOrder = externalSession ? await coreLogic(externalSession) : await withTransaction(coreLogic);

        appEvents.emit('NEW_ORDER', { order: newOrder, storeId, source: 'POS' });

        const loyaltyMsg = pointsRedeemed > 0 ? ` Points Redeemed: ${pointsRedeemed}.` : '';
        const msg = `Thank you for shopping at DailyPick! 🛒\nOrder: ${newOrder.orderNumber}\nTotal: Rs ${totalAmount}\n${loyaltyMsg}\nVisit again!`;
        notificationService.sendWhatsAppMessage(customerPhone, msg).catch(() => {}); 

        return newOrder;
    });
};
