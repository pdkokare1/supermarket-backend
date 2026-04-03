/* services/orderService.js */

const Product = require('../models/Product');
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const { withTransaction } = require('../utils/dbUtils');
const AppError = require('../utils/AppError');
const auditService = require('./auditService'); 
const cacheUtils = require('../utils/cacheUtils');

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

async function processPayLaterRefund(customerPhone, amount, session) {
    const custProfile = await Customer.findOne({ phone: customerPhone }).session(session);
    if (custProfile) {
        custProfile.creditUsed = Math.max(0, custProfile.creditUsed - amount);
        await custProfile.save({ session });
    }
}

// ==========================================
// --- CRON ABSTRACTIONS ---
// ==========================================

exports.deleteOldCancelledOrders = async (days) => {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - days);
    return await Order.deleteMany({ status: 'Cancelled', createdAt: { $lt: targetDate } });
};

exports.generateRoutineDeliveries = async () => {
    const routineOrders = await Order.find({ deliveryType: 'Routine', status: { $ne: 'Cancelled' } }).lean();
    if (routineOrders.length > 0) {
        // Optimized: Uses bulkWrite inline to prevent deep object mapping/copying into RAM
        const bulkOps = routineOrders.map(ro => ({
            insertOne: {
                document: {
                    customerName: ro.customerName, customerPhone: ro.customerPhone,
                    deliveryAddress: ro.deliveryAddress, items: ro.items,
                    totalAmount: ro.totalAmount, paymentMethod: ro.paymentMethod,
                    deliveryType: 'Instant', scheduleTime: 'Generated via Routine', status: 'Order Placed'
                }
            }
        }));
        await Order.bulkWrite(bulkOps);
    }
    return routineOrders.length;
};

// ==========================================
// --- ORDER MODIFICATION & RETRIEVAL ---
// ==========================================

exports.processPartialRefund = async (orderId, payload, user) => {
    return withTransaction(async (session) => {
        const { productId, variantId, qtyToRefund, newTotalAmount } = payload;
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new AppError('Order not found', 404);

        await Product.updateOne({ _id: productId, "variants._id": variantId }, { $inc: { "variants.$.stock": qtyToRefund } }, { session });

        if (order.storeId) {
            await Product.updateOne({ _id: productId }, { $inc: { "variants.$[var].locationInventory.$[loc].stock": qtyToRefund } }, { arrayFilters: [{ "var._id": variantId }, { "loc.storeId": order.storeId }], session }).catch(() => {});
        }

        // Optimized: streamlined array manipulation
        order.items = order.items
            .map(item => {
                if (item.productId === productId && item.variantId === variantId) {
                    item.qty -= qtyToRefund;
                }
                return item;
            })
            .filter(item => item.qty > 0);

        if (order.paymentMethod === 'Pay Later') {
            const diff = order.totalAmount - newTotalAmount;
            if (diff > 0) await processPayLaterRefund(order.customerPhone, diff, session);
        }
        
        order.totalAmount = newTotalAmount;
        await order.save({ session });

        await auditService.logEvent({ action: 'PARTIAL_REFUND', targetType: 'Order', targetId: order._id.toString(), username: user.username, userId: user.id, details: { refundedItem: productId, qty: qtyToRefund }, session });
        await cacheUtils.deleteKey('orders:analytics');
        
        return order;
    });
};

exports.processCancelOrder = async (orderId, reason, user) => {
    return withTransaction(async (session) => {
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new AppError('Order not found', 404);
        
        order.status = 'Cancelled';
        if (order.paymentMethod === 'Pay Later') await processPayLaterRefund(order.customerPhone, order.totalAmount, session);

        const bulkOperations = [];
        for (const item of order.items) {
            if (order.storeId) {
                bulkOperations.push({ updateOne: { filter: { _id: item.productId }, update: { $inc: { "variants.$[var].stock": item.qty, "variants.$[var].locationInventory.$[loc].stock": item.qty } }, arrayFilters: [{ "var._id": item.variantId }, { "loc.storeId": order.storeId }] } });
            } else {
                bulkOperations.push({ updateOne: { filter: { _id: item.productId, "variants._id": item.variantId }, update: { $inc: { "variants.$.stock": item.qty } } } });
            }
        }
        if (bulkOperations.length > 0) await Product.bulkWrite(bulkOperations, { session });

        await order.save({ session });
        
        await auditService.logEvent({ action: 'CANCEL_ORDER', targetType: 'Order', targetId: order._id.toString(), username: user ? user.username : 'System', userId: user ? user.id : null, details: { reason: reason || 'Not provided', amountRefunded: order.totalAmount }, session });
        await cacheUtils.deleteKey('orders:analytics');

        return order;
    });
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

    const [orders, total, pendingOrders] = await Promise.all([query.lean(), Order.countDocuments(filter), Order.find({ status: { $in: ['Order Placed', 'Packing'] } }).lean()]);

    return { success: true, count: orders.length, total: total, data: orders, stats: { pendingCount: pendingOrders.length, pendingRevenue: pendingOrders.reduce((sum, o) => sum + o.totalAmount, 0) } };
};

exports.getAllOrdersForExport = async () => {
    const orders = await Order.find().sort({ createdAt: -1 }).lean();
    return orders.map(o => ({ OrderID: o.orderNumber || o._id.toString(), Date: new Date(o.createdAt).toLocaleString(), CustomerName: o.customerName, Phone: o.customerPhone, TotalAmount: o.totalAmount, Status: o.status, PaymentMethod: o.paymentMethod, DeliveryType: o.deliveryType }));
};

exports.assignDriverToOrder = async (orderId, driverName, driverPhone) => {
    return await Order.findByIdAndUpdate(orderId, { deliveryDriverName: driverName, driverPhone: driverPhone || '' }, { new: true });
};

exports.updateOrderStatus = async (orderId, status) => {
    return await Order.findByIdAndUpdate(orderId, { status: status }, { new: true });
};

exports.dispatchOrder = async (orderId) => {
    return await Order.findByIdAndUpdate(orderId, { status: 'Dispatched' }, { new: true });
};

exports.getOrderById = async (orderId) => {
    return await Order.findById(orderId).lean();
};
