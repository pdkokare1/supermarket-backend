/* services/orderService.js */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const AuditLog = require('../models/AuditLog');
const sseService = require('./orderSseService');

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

async function clearAnalyticsCache() {
    if (sseService.redisCache) {
        try { await sseService.redisCache.del('orders:analytics'); } catch(e) {}
    }
}

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

async function deductInventory(items, storeId, session) {
    for (const item of items) {
        const globalUpdate = await Product.updateOne(
            { 
                _id: item.productId, 
                "variants._id": item.variantId,
                "variants.stock": { $gte: item.qty } 
            },
            { $inc: { "variants.$.stock": -item.qty } },
            { session }
        );

        if (globalUpdate.modifiedCount === 0) {
            return { success: false, message: `Insufficient global stock for item: ${item.name}` };
        }

        if (storeId) {
            const localUpdate = await Product.updateOne(
                { 
                    _id: item.productId,
                    "variants": { 
                        $elemMatch: { 
                            "_id": item.variantId, 
                            "locationInventory": { $elemMatch: { "storeId": storeId, "stock": { $gte: item.qty } } } 
                        } 
                    }
                },
                { $inc: { "variants.$[var].locationInventory.$[loc].stock": -item.qty } },
                { arrayFilters: [{ "var._id": item.variantId }, { "loc.storeId": storeId }], session }
            );
            
            if (localUpdate.modifiedCount === 0) {
                return { success: false, message: `Insufficient local store stock for item: ${item.name}` };
            }
        }
    }
    return { success: true };
}

// ==========================================
// --- TRANSACTION SERVICES ---
// ==========================================

exports.processExternalCheckout = async (payload) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { source, externalOrderId, customerName, customerPhone, deliveryAddress, items, totalAmount, paymentMethod, notes, storeId } = payload;

        const inventoryCheck = await deductInventory(items, storeId, session);
        if (!inventoryCheck.success) {
            const err = new Error(inventoryCheck.message); err.statusCode = 400; throw err;
        }

        const seqNumber = await generateOrderSequence(session);
        const orderNumber = `EXT-${source.toUpperCase().substring(0, 3)}-${seqNumber}`;
        const dateString = new Date().toISOString().split('T')[0];
        const formattedNotes = `[${source.toUpperCase()}] Ext ID: ${externalOrderId || 'N/A'}. ${notes || ''}`;

        const newOrder = new Order({
            orderNumber, dateString, storeId: storeId || null, notes: formattedNotes,
            customerName: customerName || `${source} Customer`, customerPhone: customerPhone || '', 
            deliveryAddress: deliveryAddress || `${source} Pickup`, items, totalAmount,
            paymentMethod: paymentMethod || 'Prepaid External', deliveryType: 'Instant', status: 'Order Placed'
        });

        await newOrder.save({ session });
        await session.commitTransaction();
        session.endSession();
        await clearAnalyticsCache();

        return newOrder;
    } catch (error) {
        await session.abortTransaction(); session.endSession(); throw error;
    }
};

exports.processOnlineCheckout = async (payload) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { customerName, customerPhone, deliveryAddress, items, totalAmount, deliveryType, scheduleTime, paymentMethod, notes, storeId } = payload;
        
        if (paymentMethod === 'Pay Later') {
            const customerProfile = await Customer.findOne({ phone: customerPhone }).session(session);
            if (!customerProfile || !customerProfile.isCreditEnabled) {
                const err = new Error('Pay Later is not enabled for this account.'); err.statusCode = 400; throw err;
            }
            if ((customerProfile.creditUsed + totalAmount) > customerProfile.creditLimit) {
                const err = new Error(`Credit limit exceeded. Available credit: ₹${customerProfile.creditLimit - customerProfile.creditUsed}`); err.statusCode = 400; throw err;
            }
            customerProfile.creditUsed += totalAmount;
            await customerProfile.save({ session });
        }

        let custProfile = await Customer.findOne({ phone: customerPhone }).session(session);
        if (!custProfile) {
            custProfile = new Customer({ phone: customerPhone, name: customerName });
            await custProfile.save({ session });
        } else if (custProfile.name !== customerName) {
            custProfile.name = customerName; 
            await custProfile.save({ session });
        }

        const inventoryCheck = await deductInventory(items, storeId, session);
        if (!inventoryCheck.success) {
            const err = new Error(inventoryCheck.message); err.statusCode = 400; throw err;
        }

        const seqNumber = await generateOrderSequence(session);
        const orderNumber = `ORD-${seqNumber}`;
        const dateString = new Date().toISOString().split('T')[0];

        const newOrder = new Order({
            orderNumber, dateString, storeId: storeId || null, notes: notes || '',
            customerName, customerPhone, deliveryAddress, items, totalAmount,
            paymentMethod: paymentMethod || 'Cash on Delivery', deliveryType: deliveryType || 'Instant', scheduleTime: scheduleTime || 'ASAP'
        });

        await newOrder.save({ session });
        await session.commitTransaction();
        session.endSession();
        await clearAnalyticsCache();

        const msg = `DailyPick Order Received! 🛒\nOrder ID: ${newOrder.orderNumber}\nTotal: ₹${totalAmount}\nDelivery: ${scheduleTime}\nThanks for shopping!`;
        sendWhatsAppMessage(customerPhone, msg);

        return newOrder;
    } catch (error) {
        await session.abortTransaction(); session.endSession(); throw error;
    }
};

exports.processPosCheckout = async (payload) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { customerPhone, items, totalAmount, taxAmount, discountAmount, paymentMethod, splitDetails, pointsRedeemed, notes, storeId, registerId } = payload;
        let finalCustomerName = 'Walk-in Guest';

        if (customerPhone) {
            let custProfile = await Customer.findOne({ phone: customerPhone }).session(session);
            if (custProfile) {
                finalCustomerName = custProfile.name;
                if (pointsRedeemed && pointsRedeemed > 0) {
                    custProfile.loyaltyPoints = Math.max(0, (custProfile.loyaltyPoints || 0) - pointsRedeemed);
                }
                custProfile.loyaltyPoints = (custProfile.loyaltyPoints || 0) + Math.floor(totalAmount / 100);
                
                if (paymentMethod === 'Pay Later') {
                    if (!custProfile.isCreditEnabled) {
                        const err = new Error('Pay Later disabled.'); err.statusCode = 400; throw err;
                    }
                    if ((custProfile.creditUsed + totalAmount) > custProfile.creditLimit) {
                        const err = new Error('Credit limit exceeded.'); err.statusCode = 400; throw err;
                    }
                    custProfile.creditUsed += totalAmount;
                }
                await custProfile.save({ session });
            } else {
                const earnedPoints = Math.floor(totalAmount / 100);
                custProfile = new Customer({ phone: customerPhone, name: 'In-Store Customer', loyaltyPoints: earnedPoints });
                await custProfile.save({ session });
                finalCustomerName = 'In-Store Customer';
            }
        }

        const inventoryCheck = await deductInventory(items, storeId, session);
        if (!inventoryCheck.success) {
            const err = new Error(inventoryCheck.message); err.statusCode = 400; throw err;
        }

        const seqNumber = await generateOrderSequence(session);
        const orderNumber = `ORD-${seqNumber}`;
        const dateString = new Date().toISOString().split('T')[0];

        const newOrder = new Order({
            orderNumber, dateString, storeId: storeId || null, registerId: registerId || null, notes: notes || '',
            customerName: finalCustomerName, customerPhone: customerPhone || '', deliveryAddress: 'In-Store Purchase', 
            items, totalAmount, taxAmount: taxAmount || 0, discountAmount: discountAmount || 0, paymentMethod,
            splitDetails: splitDetails || { cash: 0, upi: 0 }, deliveryType: 'Instant', status: 'Completed' 
        });

        await newOrder.save({ session });
        await session.commitTransaction();
        session.endSession();
        await clearAnalyticsCache();

        const loyaltyMsg = pointsRedeemed > 0 ? ` Points Redeemed: ${pointsRedeemed}.` : '';
        const msg = `Thank you for shopping at DailyPick! 🛒\nOrder: ${newOrder.orderNumber}\nTotal: ₹${totalAmount}\n${loyaltyMsg}\nVisit again!`;
        sendWhatsAppMessage(customerPhone, msg);

        return newOrder;
    } catch (error) {
        await session.abortTransaction(); session.endSession(); throw error;
    }
};

exports.processPartialRefund = async (orderId, payload, user) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { productId, variantId, qtyToRefund, newTotalAmount } = payload;
        const order = await Order.findById(orderId).session(session);
        if (!order) {
            const err = new Error('Order not found'); err.statusCode = 404; throw err;
        }

        await Product.updateOne(
            { _id: productId, "variants._id": variantId },
            { $inc: { "variants.$.stock": qtyToRefund } },
            { session }
        );

        if (order.storeId) {
            await Product.updateOne(
                { _id: productId },
                { $inc: { "variants.$[var].locationInventory.$[loc].stock": qtyToRefund } },
                { arrayFilters: [{ "var._id": variantId }, { "loc.storeId": order.storeId }], session }
            ).catch(() => {});
        }

        let updatedItems = [];
        for(let item of order.items) {
            if(item.productId === productId && item.variantId === variantId) {
                item.qty = item.qty - qtyToRefund;
                if(item.qty > 0) updatedItems.push(item);
            } else {
                updatedItems.push(item);
            }
        }
        order.items = updatedItems;

        if (order.paymentMethod === 'Pay Later') {
            const diff = order.totalAmount - newTotalAmount;
            if (diff > 0) {
                const custProfile = await Customer.findOne({ phone: order.customerPhone }).session(session);
                if (custProfile) {
                    custProfile.creditUsed = Math.max(0, custProfile.creditUsed - diff);
                    await custProfile.save({ session });
                }
            }
        }
        
        order.totalAmount = newTotalAmount;
        await order.save({ session });

        await AuditLog.create([{
            userId: user.id, username: user.username, action: 'PARTIAL_REFUND',
            targetType: 'Order', targetId: order._id.toString(), details: { refundedItem: productId, qty: qtyToRefund }
        }], { session });

        await session.commitTransaction();
        session.endSession();
        await clearAnalyticsCache();
        
        return order;
    } catch (error) {
        await session.abortTransaction(); session.endSession(); throw error;
    }
};

exports.processCancelOrder = async (orderId, reason, user) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const order = await Order.findById(orderId).session(session);
        if (!order) {
            const err = new Error('Order not found'); err.statusCode = 404; throw err;
        }
        
        order.status = 'Cancelled';

        if (order.paymentMethod === 'Pay Later') {
            const custProfile = await Customer.findOne({ phone: order.customerPhone }).session(session);
            if (custProfile) {
                custProfile.creditUsed = Math.max(0, custProfile.creditUsed - order.totalAmount);
                await custProfile.save({ session });
            }
        }

        for (const item of order.items) {
            await Product.updateOne(
                { _id: item.productId, "variants._id": item.variantId },
                { $inc: { "variants.$.stock": item.qty } },
                { session }
            );

            if (order.storeId) {
                await Product.updateOne(
                    { _id: item.productId },
                    { $inc: { "variants.$[var].locationInventory.$[loc].stock": item.qty } },
                    { arrayFilters: [{ "var._id": item.variantId }, { "loc.storeId": order.storeId }], session }
                ).catch(() => {});
            }
        }

        await order.save({ session });
        
        await AuditLog.create([{
            userId: user ? user.id : null, username: user ? user.username : 'System',
            action: 'CANCEL_ORDER', targetType: 'Order', targetId: order._id.toString(),
            details: { reason: reason || 'Not provided', amountRefunded: order.totalAmount }
        }], { session });
        
        await session.commitTransaction();
        session.endSession();
        await clearAnalyticsCache();

        return order;
    } catch (error) {
        await session.abortTransaction(); session.endSession(); throw error;
    }
};
