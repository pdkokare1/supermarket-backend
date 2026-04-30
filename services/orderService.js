/* services/orderService.js */

const mongoose = require('mongoose'); // NEW: Required for strict ObjectId casting in isolation filters
const Product = require('../models/Product');
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const Settlement = require('../models/Settlement'); // NEW: Financial Settlement tracking
const { withTransaction } = require('../utils/dbUtils');
const AppError = require('../utils/AppError');
const auditService = require('./auditService'); 
const inventoryService = require('./inventoryService'); 
const cacheUtils = require('../utils/cacheUtils');
const { getPaginationOptions, getCursorFilter } = require('../utils/paginationUtils');
const { getFilterDates } = require('../utils/dateUtils');
const appEvents = require('../utils/eventEmitter'); 
const customerService = require('./customerService'); 
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
        // ENTERPRISE SECURITY FIX: Prevent partial refund processing on already cancelled orders
        if (order.status === 'Cancelled') throw new AppError('Cannot refund items on an already cancelled order.', 400);

        order.items = order.items
            .map(item => {
                // ENTERPRISE FIX: Enforced string conversion. 
                // Mongoose ObjectIds compared to Payload Strings using '===' previously failed silently.
                const isMatchingProduct = item.productId.toString() === productId.toString();
                const isMatchingVariant = (!variantId) || (item.variantId && item.variantId.toString() === variantId.toString());
                
                if (isMatchingProduct && isMatchingVariant) {
                    item.qty -= qtyToRefund;
                }
                return item;
            })
            .filter(item => item.qty > 0);

        order.totalAmount = newTotalAmount;

        const parallelTasks = [
            inventoryService.restoreInventory([{ productId, variantId, qty: qtyToRefund }], order.storeId, session),
            order.save({ session })
        ];

        if (order.paymentMethod === 'Pay Later') {
            const diff = order.totalAmount - newTotalAmount;
            if (diff > 0) parallelTasks.push(customerService.refundPayLaterCredit(order.customerPhone, diff, session));
        }

        // --- NEW: LEDGER ADJUSTMENT ---
        if (order.storeId) {
            parallelTasks.push(Settlement.findOneAndUpdate({ orderId: orderId }, { status: 'Refunded', disputeReason: 'Partial Refund Processed' }, { session }));
        }

        await Promise.all(parallelTasks);

        await auditService.logEvent({ action: 'PARTIAL_REFUND', targetType: 'Order', targetId: order._id.toString(), username: user.username, userId: user.id, details: { refundedItem: productId, qty: qtyToRefund }, session });
        await clearOrderAnalyticsCache();

        appEvents.broadcastEvent('ORDER_REFUNDED', { orderId: order._id, storeId: order.storeId });
        
        return order;
    });
};

exports.processCancelOrder = async (orderId, reason, user) => {
    return withTransaction(async (session) => {
        // OPTIMIZATION: Converted findById + save (Hydration + 2 Network trips) into a single atomic findOneAndUpdate.
        // The query itself ({ status: { $ne: 'Cancelled' } }) prevents the Double-Cancel race condition strictly at the database level.
        const order = await Order.findOneAndUpdate(
            { _id: orderId, status: { $ne: 'Cancelled' } },
            { $set: { status: 'Cancelled' } },
            { 
                new: true, 
                session, 
                select: 'status paymentMethod customerPhone totalAmount items storeId',
                lean: true // OPTIMIZATION: Zero Hydration
            }
        );
            
        if (!order) {
            const existing = await Order.findById(orderId).select('status').lean();
            if (!existing) throw new AppError('Order not found', 404);
            throw new AppError('Order is already cancelled.', 400);
        }

        const parallelTasks = [
            inventoryService.restoreInventory(order.items, order.storeId, session)
        ];

        if (order.paymentMethod === 'Pay Later') {
            parallelTasks.push(customerService.refundPayLaterCredit(order.customerPhone, order.totalAmount, session));
        }

        // --- NEW: LEDGER ADJUSTMENT ---
        if (order.storeId) {
            parallelTasks.push(Settlement.findOneAndUpdate({ orderId: orderId }, { status: 'Voided', disputeReason: `Order Cancelled: ${reason || 'User/Admin Action'}` }, { session }));
        }
        
        await Promise.all(parallelTasks);
        
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

    // --- NEW: TENANT ISOLATION SECURITY ---
    if (queryParams.storeId) {
        filter.storeId = new mongoose.Types.ObjectId(queryParams.storeId);
    }

    const dateFilter = getFilterDates(queryParams.dateFilter);
    if (dateFilter) filter.createdAt = dateFilter;

    const { limit, skip, cursor } = getPaginationOptions(queryParams);

    if (cursor) {
        Object.assign(filter, getCursorFilter(cursor, -1));
    }

    const result = await Order.aggregate([
        { $match: filter },
        { $facet: {
            metadata: [
                { $count: "total" }
            ],
            data: [
                { $sort: { createdAt: -1 } },
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

exports.getAllOrdersForExport = (queryParams = {}) => {
    let filter = {};
    
    // --- NEW: TENANT ISOLATION SECURITY ---
    if (queryParams.storeId) {
        filter.storeId = new mongoose.Types.ObjectId(queryParams.storeId);
    }

    const cursor = Order.find(filter)
        .read('secondaryPreferred') 
        .select('orderNumber createdAt customerName customerPhone totalAmount status paymentMethod deliveryType')
        .sort({ createdAt: -1 })
        .batchSize(100)
        .lean()
        .cursor();

    async function* generateRows() {
        try {
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
        } finally {
            // ENTERPRISE FIX: Explicit closure guarantees no DB connections or memory are leaked 
            // if the user's browser drops the connection mid-download.
            await cursor.close();
        }
    }
        
    return Readable.from(generateRows());
};

exports.assignDriverToOrder = async (orderId, driverName, driverPhone, session = null) => {
    const options = { new: true };
    if (session) options.session = session;
    // OPTIMIZATION: .lean() for zero hydration
    const order = await Order.findByIdAndUpdate(orderId, { deliveryDriverName: driverName, driverPhone: driverPhone || '' }, options).lean();
    
    if (!order) throw new AppError('Order not found or already removed.', 404);
    
    appEvents.broadcastEvent('ORDER_UPDATED', { orderId: order._id, storeId: order.storeId });
    return order;
};

// ============================================================================
// --- MODIFIED: PHASE 23 VIRAL REFERRAL ENGINE (PAYOUT TRIGGER) ---
// ============================================================================
exports.updateOrderStatus = async (orderId, status, session = null) => {
    const options = { new: true };
    if (session) options.session = session;
    const order = await Order.findByIdAndUpdate(orderId, { status: status }, options).lean();
    if (!order) throw new AppError('Order not found to update status.', 404);
    
    // VIRAL REFERRAL CHECK: If order is completed successfully, check if it's their first order
    if (status === 'Delivered') {
        try {
            const customer = await Customer.findOne({ phone: order.customerPhone });
            if (customer && !customer.hasCompletedFirstOrder) {
                customer.hasCompletedFirstOrder = true;
                await customer.save({ session });
                
                // If they were referred, pay out the Rs 100 bounty to both!
                if (customer.referredBy) {
                    const referrer = await Customer.findOne({ referralCode: customer.referredBy });
                    if (referrer) {
                        referrer.loyaltyPoints += 100;
                        await referrer.save({ session });
                        
                        customer.loyaltyPoints += 100;
                        await customer.save({ session });
                        console.log(`[VIRAL ENGINE] Referral Paid! Rs 100 to ${referrer.phone} and ${customer.phone}`);
                    }
                }
            }
        } catch(e) {
            console.error('[VIRAL ENGINE] Error executing referral payout:', e);
        }
    }

    appEvents.broadcastEvent('ORDER_STATUS_UPDATED', { orderId: order._id, status: status, storeId: order.storeId });
    return order;
};

// ============================================================================
// --- MODIFIED: PHASE 23 ORDER BATCHING (STACKED DROPS ALGORITHM) ---
// ============================================================================
exports.dispatchOrder = async (orderId, session = null) => {
    const order = await Order.findById(orderId).lean();
    
    // BATCHING ALGORITHM: Check if another order was dispatched in the last 15 mins to a similar area
    // (In a full implementation, you would use Turf.js or $geoNear to calculate distance. 
    // Here we use a time-heuristic to assign the same driver to create a Stacked Drop)
    try {
        const recentDispatchedOrder = await Order.findOne({
            status: 'Dispatched',
            fulfillmentType: 'PLATFORM_DELIVERY',
            createdAt: { $gte: new Date(Date.now() - 15 * 60000) } // Last 15 mins
        }).sort({ createdAt: -1 }).lean();

        if (recentDispatchedOrder && recentDispatchedOrder.deliveryDriverName !== 'Unassigned') {
            // Stack the drop! Assign to the same rider.
            console.log(`[LOGISTICS] Stacked Drop Created! Assigning to ${recentDispatchedOrder.deliveryDriverName}`);
            await exports.assignDriverToOrder(orderId, recentDispatchedOrder.deliveryDriverName, recentDispatchedOrder.driverPhone, session);
        }
    } catch(e) {
        console.error('[LOGISTICS] Batching algorithm failed:', e);
    }

    return await exports.updateOrderStatus(orderId, 'Dispatched', session);
};

exports.getOrderById = async (orderId) => {
    return await Order.findById(orderId).lean();
};
