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
const { getFilterDates } = require('../utils/dateUtils');
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

const clearOrderAnalyticsCache = async () => {
    await cacheUtils.deleteKey('orders:analytics');
};

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
        await clearOrderAnalyticsCache();

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
        await clearOrderAnalyticsCache();

        appEvents.emit('ORDER_STATUS_UPDATED', { orderId: order._id, status: 'Cancelled', storeId: order.storeId });

        return order;
    });
};

exports.getOrdersList = async (queryParams) => {
    let filter = {};
    if (queryParams.tab === 'Instant') filter.deliveryType = { $ne: 'Routine' };
    if (queryParams.tab === 'Routine') filter.deliveryType = 'Routine';

    const dateFilter = getFilterDates(queryParams.dateFilter);
    if (dateFilter) filter.createdAt = dateFilter;

    const { limit, skip } = getPaginationOptions(queryParams);

    // OPTIMIZATION: Single-Pass Aggregation with Root Match
    // By matching at the root level before $facet, we shrink the pipeline's memory footprint drastically.
    const result = await Order.aggregate([
        { $match: filter },
        { $facet: {
            metadata: [
                { $count: "total" }
            ],
            data: [
                { $sort: { createdAt: -1 } },
                { $skip: skip },
                { $limit: limit || 50 }
            ],
            stats: [
                { $match: { status: { $in: ['Order Placed', 'Packing'] } } },
                { $group: { _id: null, pendingCount: { $sum: 1 }, pendingRevenue: { $sum: "$totalAmount" } } }
            ]
        }}
    ]);

    const orders = result[0].data;
    const total = result[0].metadata[0]?.total || 0;
    const pendingStats = result[0].stats[0] || { pendingCount: 0, pendingRevenue: 0 };

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
    const exportData = [];
    // Memory Efficient: Use Cursor for large datasets to prevent V8 memory spikes
    const cursor = Order.find()
        .select('orderNumber createdAt customerName customerPhone totalAmount status paymentMethod deliveryType')
        .sort({ createdAt: -1 })
        .cursor();

    for (let o = await cursor.next(); o != null; o = await cursor.next()) {
        exportData.push({ 
            OrderID: o.orderNumber || o._id.toString(), 
            Date: new Date(o.createdAt).toLocaleString(), 
            CustomerName: o.customerName, 
            Phone: o.customerPhone, 
            TotalAmount: o.totalAmount, 
            Status: o.status, 
            PaymentMethod: o.paymentMethod, 
            DeliveryType: o.deliveryType 
        });
    }
        
    return exportData;
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
    return await exports.updateOrderStatus(orderId, 'Dispatched');
};

exports.getOrderById = async (orderId) => {
    return await Order.findById(orderId).lean();
};
