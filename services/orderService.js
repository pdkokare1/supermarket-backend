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

// NEW: Consolidated Pay Later charge validation
function validateAndApplyPayLater(custProfile, amount) {
    if (!custProfile || !custProfile.isCreditEnabled) {
        const err = new Error('Pay Later is not enabled for this account.'); err.statusCode = 400; throw err;
    }
    if ((custProfile.creditUsed + amount) > custProfile.creditLimit) {
        const err = new Error(`Credit limit exceeded. Available credit: ₹${custProfile.creditLimit - custProfile.creditUsed}`); err.statusCode = 400; throw err;
    }
    custProfile.creditUsed += amount;
}

// NEW: Consolidated Pay Later refund processing
async function processPayLaterRefund(customerPhone, amount, session) {
    const custProfile = await Customer.findOne({ phone: customerPhone }).session(session);
    if (custProfile) {
        custProfile.creditUsed = Math.max(0, custProfile.creditUsed - amount);
        await custProfile.save({ session });
    }
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
        
        let custProfile = await Customer.findOne({ phone: customerPhone }).session(session);
        
        if (paymentMethod === 'Pay Later') {
            validateAndApplyPayLater(custProfile, totalAmount);
        }

        if (!custProfile) {
            custProfile = new Customer({ phone: customerPhone, name: customerName });
            if (paymentMethod === 'Pay Later') {
                const err = new Error('Pay Later is not enabled for this new account.'); err.statusCode = 400; throw err;
            }
        } else if (custProfile.name !== customerName) {
            custProfile.name = customerName; 
        }
        await custProfile.save({ session });

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
                    validateAndApplyPayLater(custProfile, totalAmount);
                }
                await custProfile.save({ session });
            } else {
                if (paymentMethod === 'Pay Later') {
                    const err = new Error('Pay Later is not enabled for this new account.'); err.statusCode = 400; throw err;
                }
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
                await processPayLaterRefund(order.customerPhone, diff, session);
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
            await processPayLaterRefund(order.customerPhone, order.totalAmount, session);
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

// ==========================================
// --- DATA RETRIEVAL SERVICES (NEW) ---
// ==========================================

exports.getAnalyticsData = async () => {
    if (sseService.redisCache) {
        const cachedAnalytics = await sseService.redisCache.get('orders:analytics');
        if (cachedAnalytics) return JSON.parse(cachedAnalytics); 
    }
    
    const today = new Date(); today.setHours(23, 59, 59, 999);
    const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(today.getDate() - 6); sevenDaysAgo.setHours(0, 0, 0, 0);

    const revenueAgg = await Order.aggregate([
        { $match: { status: { $in: ['Dispatched', 'Completed'] }, createdAt: { $gte: sevenDaysAgo, $lte: today } } },
        { $group: { _id: "$dateString", dailyRevenue: { $sum: "$totalAmount" } } },
        { $sort: { _id: 1 } }
    ]);

    let revenueLast7Days = [0, 0, 0, 0, 0, 0, 0];
    const datesToMap = [];
    for(let i=0; i<7; i++){
        const d = new Date(sevenDaysAgo); d.setDate(sevenDaysAgo.getDate() + i); datesToMap.push(d.toISOString().split('T')[0]);
    }
    
    revenueAgg.forEach(item => {
        const index = datesToMap.indexOf(item._id);
        if (index !== -1) revenueLast7Days[index] = item.dailyRevenue;
    });

    const topItemsAgg = await Order.aggregate([
        { $match: { status: { $in: ['Dispatched', 'Completed'] }, createdAt: { $gte: sevenDaysAgo, $lte: today } } },
        { $unwind: "$items" },
        { $group: { _id: { name: "$items.name", variant: "$items.selectedVariant" }, qty: { $sum: "$items.qty" }, revenue: { $sum: { $multiply: ["$items.price", "$items.qty"] } } } },
        { $sort: { qty: -1 } },
        { $limit: 5 }
    ]);

    const topItems = topItemsAgg.map(item => ({ name: `${item._id.name} (${item._id.variant})`, qty: item.qty, revenue: item.revenue }));

    const responsePayload = { success: true, data: { chartLabels: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Yesterday', 'Today'], revenueData: revenueLast7Days, topItems: topItems } };
    if (sseService.redisCache) await sseService.redisCache.set('orders:analytics', JSON.stringify(responsePayload), 'EX', 900);

    return responsePayload;
};

exports.getOrdersList = async (queryParams) => {
    let filter = {};
    if (queryParams.tab === 'Instant') filter.deliveryType = { $ne: 'Routine' };
    if (queryParams.tab === 'Routine') filter.deliveryType = 'Routine';

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    if (queryParams.dateFilter === 'Today') filter.createdAt = { $gte: today };
    else if (queryParams.dateFilter === 'Yesterday') filter.createdAt = { $gte: yesterday, $lt: today };
    else if (queryParams.dateFilter === '7Days') filter.createdAt = { $gte: sevenDaysAgo };

    const page = parseInt(queryParams.page) || 1;
    const limit = parseInt(queryParams.limit);

    let query = Order.find(filter).sort({ createdAt: -1 });
    if (limit) query = query.skip((page - 1) * limit).limit(limit);

    const [orders, total, pendingOrders] = await Promise.all([
        query.lean(), Order.countDocuments(filter), Order.find({ status: { $in: ['Order Placed', 'Packing'] } }).lean()
    ]);

    return { 
        success: true, count: orders.length, total: total, data: orders,
        stats: { pendingCount: pendingOrders.length, pendingRevenue: pendingOrders.reduce((sum, o) => sum + o.totalAmount, 0) }
    };
};

exports.getAllOrdersForExport = async () => {
    const orders = await Order.find().sort({ createdAt: -1 }).lean();
    return orders.map(o => ({
        OrderID: o.orderNumber || o._id.toString(), Date: new Date(o.createdAt).toLocaleString(),
        CustomerName: o.customerName, Phone: o.customerPhone, TotalAmount: o.totalAmount,
        Status: o.status, PaymentMethod: o.paymentMethod, DeliveryType: o.deliveryType
    }));
};
