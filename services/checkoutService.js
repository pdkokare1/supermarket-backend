/* services/checkoutService.js */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const inventoryService = require('./inventoryService'); 
const { withTransaction } = require('../utils/dbUtils');
const AppError = require('../utils/AppError');
const cacheUtils = require('../utils/cacheUtils');
const appEvents = require('../utils/eventEmitter'); 

function sendWhatsAppMessage(phone, msg) {
    if (phone && phone.length >= 10 && process.env.CALLMEBOT_API_KEY && process.env.WA_PHONE_NUMBER) {
        const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(msg)}&apikey=${process.env.CALLMEBOT_API_KEY}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        fetch(waUrl, { signal: controller.signal }).catch(() => {}).finally(() => clearTimeout(timeoutId)); 
    }
}

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
        throw new AppError(`Credit limit exceeded. Available credit: ₹${custProfile.creditLimit - custProfile.creditUsed}`, 400);
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

exports.processExternalCheckout = async (payload) => {
    const newOrder = await withTransaction(async (session) => {
        const { source, externalOrderId, customerName, customerPhone, deliveryAddress, items, totalAmount, paymentMethod, notes, storeId } = payload;
        const orderPrefix = `EXT-${source.toUpperCase().substring(0, 3)}`;
        const formattedNotes = `[${source.toUpperCase()}] Ext ID: ${externalOrderId || 'N/A'}. ${notes || ''}`;
        const orderData = { notes: formattedNotes, customerName: customerName || `${source} Customer`, customerPhone: customerPhone || '', deliveryAddress: deliveryAddress || `${source} Pickup`, totalAmount, paymentMethod: paymentMethod || 'Prepaid External', deliveryType: 'Instant', status: 'Order Placed' };
        return await finalizeAndSaveOrder(session, items, storeId, orderPrefix, orderData);
    });

    appEvents.emit('NEW_ORDER', { order: newOrder, storeId: payload.storeId, source: payload.source });
    return newOrder;
};

exports.processOnlineCheckout = async (payload) => {
    const { customerName, customerPhone, deliveryAddress, items, totalAmount, deliveryType, scheduleTime, paymentMethod, notes, storeId } = payload;
    
    const newOrder = await withTransaction(async (session) => {
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

        appEvents.emit('CUSTOMER_UPDATED', { phone: custProfile.phone });

        const orderData = { notes: notes || '', customerName, customerPhone, deliveryAddress, totalAmount, paymentMethod: paymentMethod || 'Cash on Delivery', deliveryType: deliveryType || 'Instant', scheduleTime: scheduleTime || 'ASAP' };
        return await finalizeAndSaveOrder(session, items, storeId, 'ORD', orderData);
    });

    appEvents.emit('NEW_ORDER', { order: newOrder, storeId, source: 'Online' });

    const msg = `DailyPick Order Received! 🛒\nOrder ID: ${newOrder.orderNumber}\nTotal: ₹${totalAmount}\nDelivery: ${scheduleTime || 'ASAP'}\nThanks for shopping!`;
    sendWhatsAppMessage(customerPhone, msg);

    return newOrder;
};

exports.processPosCheckout = async (payload) => {
    const { customerPhone, items, totalAmount, taxAmount, discountAmount, paymentMethod, splitDetails, pointsRedeemed, notes, storeId, registerId } = payload;
    
    const newOrder = await withTransaction(async (session) => {
        let finalCustomerName = 'Walk-in Guest';

        if (customerPhone) {
            let custProfile = await Customer.findOne({ phone: customerPhone })
                .select('name phone loyaltyPoints creditUsed creditLimit isCreditEnabled')
                .session(session);
                
            if (custProfile) {
                finalCustomerName = custProfile.name;
                if (pointsRedeemed && pointsRedeemed > 0) custProfile.loyaltyPoints = Math.max(0, (custProfile.loyaltyPoints || 0) - pointsRedeemed);
                custProfile.loyaltyPoints = (custProfile.loyaltyPoints || 0) + Math.floor(totalAmount / 100);
                if (paymentMethod === 'Pay Later') validateAndApplyPayLater(custProfile, totalAmount);
                await custProfile.save({ session });
                
                appEvents.emit('CUSTOMER_UPDATED', { phone: custProfile.phone });
            } else {
                if (paymentMethod === 'Pay Later') throw new AppError('Pay Later is not enabled for this new account.', 400);
                const earnedPoints = Math.floor(totalAmount / 100);
                custProfile = new Customer({ phone: customerPhone, name: 'In-Store Customer', loyaltyPoints: earnedPoints });
                await custProfile.save({ session });
                finalCustomerName = 'In-Store Customer';
                
                appEvents.emit('CUSTOMER_UPDATED', { phone: custProfile.phone });
            }
        }

        const orderData = { registerId: registerId || null, notes: notes || '', customerName: finalCustomerName, customerPhone: customerPhone || '', deliveryAddress: 'In-Store Purchase', totalAmount, taxAmount: taxAmount || 0, discountAmount: discountAmount || 0, paymentMethod, splitDetails: splitDetails || { cash: 0, upi: 0 }, deliveryType: 'Instant', status: 'Completed' };
        return await finalizeAndSaveOrder(session, items, storeId, 'ORD', orderData);
    });

    appEvents.emit('NEW_ORDER', { order: newOrder, storeId, source: 'POS' });

    const loyaltyMsg = pointsRedeemed > 0 ? ` Points Redeemed: ${pointsRedeemed}.` : '';
    const msg = `Thank you for shopping at DailyPick! 🛒\nOrder: ${newOrder.orderNumber}\nTotal: ₹${totalAmount}\n${loyaltyMsg}\nVisit again!`;
    sendWhatsAppMessage(customerPhone, msg);

    return newOrder;
};
