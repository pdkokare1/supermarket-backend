/* services/orderService.js */

const Product = require('../models/Product');
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const { withTransaction } = require('../utils/dbUtils');
const AppError = require('../utils/AppError');
const auditService = require('./auditService'); 
const cacheUtils = require('../utils/cacheUtils');
const { getPaginationOptions } = require('../utils/paginationUtils');

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

// OPTIMIZED: Unified inventory restoration helper for both Refunds and Cancellations
async function restoreInventory(items, storeId, session) {
    const bulkOperations = [];
    for (const item of items) {
        if (storeId) {
            bulkOperations.push({ 
                updateOne: { 
                    filter: { _id: item.productId }, 
                    update: { $inc: { "variants.$[var].stock": item.qty, "variants.$[var].locationInventory.$[loc].stock": item.qty } }, 
                    arrayFilters: [{ "var._id": item.variantId }, { "loc.storeId": storeId }] 
                } 
            });
        } else {
            bulkOperations.push({ 
                updateOne: { 
                    filter: { _id: item.productId, "variants._id": item.variantId }, 
                    update: { $inc: { "variants.$.stock": item.qty } } 
                } 
            });
        }
    }
    if (bulkOperations.length > 0) {
        await Product.bulkWrite(bulkOperations, { session });
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

        // OPTIMIZED: Call unified helper instead of repeating update queries
        await restoreInventory([{ productId, variantId, qty: qtyToRefund }], order.storeId, session);

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

        // OPTIMIZED: Call unified helper to handle database stock restoration
        await restoreInventory(order.items, order.storeId, session);

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

    // OPTIMIZED: Centralized pagination utility
    const { limit, skip } = getPaginationOptions(queryParams);

    let query = Order.find(filter).sort({ createdAt: -1 });
    if (limit > 0) query = query.skip(skip).limit(limit);

    // OPTIMIZED: Database-level aggregation for pending stats instead of pulling massive arrays into RAM
    const statsPromise = Order.aggregate([
        { $match: { status: { $in: ['Order Placed', 'Packing'] } } },
        { $group: { _id: null, pendingCount: { $sum: 1 }, pendingRevenue: { $sum: "$totalAmount" } } }
    ]);

    const [orders, total, pendingStatsArray] = await Promise.all([
        query.lean(), 
        Order.countDocuments(filter), 
        statsPromise
    ]);
    
    // Safely extract stats or default to 0
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
    // OPTIMIZED: Added .select() to vastly reduce network payload and RAM usage during exports
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
