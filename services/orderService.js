/* services/orderService.js */

const Product = require('../models/Product');
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const { withTransaction } = require('../utils/dbUtils');
const AppError = require('../utils/AppError');
const auditService = require('./auditService'); 
const inventoryService = require('./inventoryService'); 
const cacheUtils = require('../utils/cacheUtils');
const { getPaginationOptions } = require('../utils/paginationUtils');
const appEvents = require('../utils/eventEmitter'); 

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
// --- ORDER MODIFICATION & RETRIEVAL ---
// ==========================================

exports.processPartialRefund = async (orderId, payload, user) => {
    return withTransaction(async (session) => {
        const { productId, variantId, qtyToRefund, newTotalAmount } = payload;
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new AppError('Order not found', 404);

        await inventoryService.restoreInventory([{ productId, variantId, qty: qtyToRefund }], order.storeId, session);

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

        appEvents.emit('ORDER_REFUNDED', { orderId: order._id, storeId: order.storeId });
        
        return order;
    });
};

exports.processCancelOrder = async (orderId, reason, user) => {
    return withTransaction(async (session) => {
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new AppError('Order not found', 404);
        
        order.status = 'Cancelled';
        if (order.paymentMethod === 'Pay Later') await processPayLaterRefund(order.customerPhone, order.totalAmount, session);

        await inventoryService.restoreInventory(order.items, order.storeId, session);
        await order.save({ session });
        
        await auditService.logEvent({ action: 'CANCEL_ORDER', targetType: 'Order', targetId: order._id.toString(), username: user ? user.username : 'System', userId: user ? user.id : null, details: { reason: reason || 'Not provided', amountRefunded: order.totalAmount }, session });
        await cacheUtils.deleteKey('orders:analytics');

        appEvents.emit('ORDER_STATUS_UPDATED', { orderId: order._id, status: 'Cancelled', storeId: order.storeId });

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

    const { limit, skip } = getPaginationOptions(queryParams);

    let query = Order.find(filter).sort({ createdAt: -1 });
    if (limit > 0) query = query.skip(skip).limit(limit);

    const statsPromise = Order.aggregate([
        { $match: { status: { $in: ['Order Placed', 'Packing'] } } },
        { $group: { _id: null, pendingCount: { $sum: 1 }, pendingRevenue: { $sum: "$totalAmount" } } }
    ]);

    const [orders, total, pendingStatsArray] = await Promise.all([
        query.lean(), 
        Order.countDocuments(filter), 
        statsPromise
    ]);
    
    const pendingStats = pendingStatsArray[0] || { pendingCount: 0, pendingRevenue: 0 };

    return { 
        success: true, 
        count: orders.length, 
        total: total, 
        data: orders, 
        stats: { 
            pendingCount: pendingStats.pendingCount, 
            pendingRevenue: pendingStats.pendingRevenue 
        } 
    };
};

exports.getAllOrdersForExport = async () => {
    const orders = await Order.find()
        .select('orderNumber createdAt customerName customerPhone totalAmount status paymentMethod deliveryType')
        .sort({ createdAt: -1 })
        .lean();
        
    return orders.map(o => ({ 
        OrderID: o.orderNumber || o._id.toString(), 
        Date: new Date(o.createdAt).toLocaleString(), 
        CustomerName: o.customerName, 
        Phone: o.customerPhone, 
        TotalAmount: o.totalAmount, 
        Status: o.status, 
        PaymentMethod: o.paymentMethod, 
        DeliveryType: o.deliveryType 
    }));
};

exports.assignDriverToOrder = async (orderId, driverName, driverPhone) => {
    const order = await Order.findByIdAndUpdate(orderId, { deliveryDriverName: driverName, driverPhone: driverPhone || '' }, { new: true });
    if (order) {
        appEvents.emit('ORDER_UPDATED', { orderId: order._id, storeId: order.storeId });
    }
    return order;
};

exports.updateOrderStatus = async (orderId, status) => {
    const order = await Order.findByIdAndUpdate(orderId, { status: status }, { new: true });
    if (order) {
        appEvents.emit('ORDER_STATUS_UPDATED', { orderId: order._id, status: status, storeId: order.storeId });
    }
    return order;
};

exports.dispatchOrder = async (orderId) => {
    const order = await Order.findByIdAndUpdate(orderId, { status: 'Dispatched' }, { new: true });
    if (order) {
        appEvents.emit('ORDER_STATUS_UPDATED', { orderId: order._id, status: 'Dispatched', storeId: order.storeId });
    }
    return order;
};

exports.getOrderById = async (orderId) => {
    return await Order.findById(orderId).lean();
};
