/* services/orderService.js */

const Product = require('../models/Product');
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const { withTransaction } = require('../utils/dbUtils');
const AppError = require('../utils/AppError');
const auditService = require('./auditService'); 
const inventoryService = require('./inventoryService'); 
const cacheUtils = require('../utils/cacheUtils');
const { getPaginationOptions, getCursorFilter } = require('../utils/paginationUtils');
const { getFilterDates } = require('../utils/dateUtils');
const appEvents = require('../utils/eventEmitter'); 
const customerService = require('./customerService'); // DOMAIN INTEGRATION
const { Readable } = require('stream');

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

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
            if (diff > 0) await customerService.refundPayLaterCredit(order.customerPhone, diff, session);
        }
        
        order.totalAmount = newTotalAmount;
        await order.save({ session });

        await auditService.logEvent({ action: 'PARTIAL_REFUND', targetType: 'Order', targetId: order._id.toString(), username: user.username, userId: user.id, details: { refundedItem: productId, qty: qtyToRefund }, session });
        await clearOrderAnalyticsCache();

        appEvents.broadcastEvent('ORDER_REFUNDED', { orderId: order._id, storeId: order.storeId });
        
        return order;
    });
};

exports.processCancelOrder = async (orderId, reason, user) => {
    return withTransaction(async (session) => {
        // OPTIMIZATION: Added .select() projection to significantly reduce BSON payload size during memory hydration
        const order = await Order.findById(orderId)
            .select('status paymentMethod customerPhone totalAmount items storeId')
            .session(session);
            
        if (!order) throw new AppError('Order not found', 404);
        
        order.status = 'Cancelled';
        if (order.paymentMethod === 'Pay Later') await customerService.refundPayLaterCredit(order.customerPhone, order.totalAmount, session);

        await inventoryService.restoreInventory(order.items, order.storeId, session);
        await order.save({ session });
        
        await auditService.logEvent({ action: 'CANCEL_ORDER', targetType: 'Order', targetId: order._id.toString(), username: user ? user.username : 'System', userId: user ? user.id : null, details: { reason: reason || 'Not provided', amountRefunded: order.totalAmount }, session });
        await clearOrderAnalyticsCache();

        appEvents.broadcastEvent('ORDER_STATUS_UPDATED', { orderId: order._id, status: 'Cancelled', storeId: order.storeId });

        return order;
    });
};

exports.getOrdersList = async (queryParams) => {
    let filter = {};
    if (queryParams.tab === 'Instant') filter.deliveryType = { $ne: 'Routine' };
    if (queryParams.tab === 'Routine') filter.deliveryType = 'Routine';

    const dateFilter = getFilterDates(queryParams.dateFilter);
    if (dateFilter) filter.createdAt = dateFilter;

    const { limit, skip, cursor } = getPaginationOptions(queryParams);

    // OPTIMIZATION: Inject O(1) Cursor matching safely combining with other filters
    if (cursor) {
        Object.assign(filter, getCursorFilter(cursor, -1));
    }

    // OPTIMIZATION: Single-Pass Aggregation with Root Match
    const result = await Order.aggregate([
        { $match: filter },
        { $facet: {
            metadata: [
                { $count: "total" }
            ],
            data: [
                { $sort: { createdAt: -1 } },
                // If using cursor, skip becomes 0 automatically preventing slow DB scans
                { $skip: cursor ? 0 : skip },
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
    
    // OPTIMIZATION: Return the nextCursor natively to the frontend
    const nextCursor = orders.length > 0 ? orders[orders.length - 1]._id : null;

    return { 
        success: true, 
        count: orders.length, 
        total: total, 
        nextCursor: nextCursor,
        data: orders, 
        stats: { 
            pendingCount: pendingStats.pendingCount, 
            pendingRevenue: pendingStats.pendingRevenue 
        } 
    };
};

exports.getAllOrdersForExport = () => {
    const cursor = Order.find()
        .read('secondaryPreferred') // ENTERPRISE FIX: Offloads heavy admin export queries to read replicas to prevent primary DB CPU spikes during live checkouts.
        .select('orderNumber createdAt customerName customerPhone totalAmount status paymentMethod deliveryType')
        .sort({ createdAt: -1 })
        // OPTIMIZATION: Added explicit batch size to prevent DB Cursor exhaustion on large enterprise exports
        .batchSize(100)
        // ENTERPRISE OPTIMIZATION: Bypassing Mongoose document hydration to prevent OOM errors on massive exports
        .lean()
        .cursor();

    // OPTIMIZATION: Async Generator stream pipeline ensures O(1) memory footprint for enterprise-scale exports
    async function* generateRows() {
        for await (const o of cursor) {
            yield { 
                OrderID: o.orderNumber || o._id.toString(), 
                Date: new Date(o.createdAt).toLocaleString(), 
                CustomerName: o.customerName || '', 
                Phone: o.customerPhone || '', 
                TotalAmount: o.totalAmount || 0, 
                Status: o.status || '', 
                PaymentMethod: o.paymentMethod || '', 
                DeliveryType: o.deliveryType || '' 
            };
        }
    }
        
    return Readable.from(generateRows());
};

// OPTIMIZATION: Added optional 'session' parameter to allow these functions to be wrapped in larger transactions if needed
exports.assignDriverToOrder = async (orderId, driverName, driverPhone, session = null) => {
    const options = { new: true };
    if (session) options.session = session;
    const order = await Order.findByIdAndUpdate(orderId, { deliveryDriverName: driverName, driverPhone: driverPhone || '' }, options);
    if (order) {
        appEvents.broadcastEvent('ORDER_UPDATED', { orderId: order._id, storeId: order.storeId });
    }
    return order;
};

exports.updateOrderStatus = async (orderId, status, session = null) => {
    const options = { new: true };
    if (session) options.session = session;
    const order = await Order.findByIdAndUpdate(orderId, { status: status }, options);
    if (order) {
        appEvents.broadcastEvent('ORDER_STATUS_UPDATED', { orderId: order._id, status: status, storeId: order.storeId });
    }
    return order;
};

exports.dispatchOrder = async (orderId, session = null) => {
    return await exports.updateOrderStatus(orderId, 'Dispatched', session);
};

exports.getOrderById = async (orderId) => {
    return await Order.findById(orderId).lean();
};
