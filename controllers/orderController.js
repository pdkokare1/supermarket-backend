/* controllers/orderController.js */

const Order = require('../models/Order');
const { Parser } = require('json2csv'); 
const sseService = require('../services/orderSseService');
const orderService = require('../services/orderService'); // NEW IMPORT

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.streamAdmin = async (request, reply) => {
    reply.hijack(); 
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': request.headers.origin || '*',  
        'Access-Control-Allow-Credentials': 'true',
        'X-Accel-Buffering': 'no'            
    });
    reply.raw.write('data: {"message": "Admin Stream Connected"}\n\n');
    
    sseService.addAdminConnection(reply.raw);

    request.raw.on('close', () => {
        sseService.removeAdminConnection(reply.raw);
    });
};

exports.streamCustomer = async (request, reply) => {
    reply.hijack(); 
    const orderId = request.params.id;
    
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': request.headers.origin || '*',  
        'Access-Control-Allow-Credentials': 'true',
        'X-Accel-Buffering': 'no'            
    });
    reply.raw.write('data: {"message": "Tracking Stream Connected"}\n\n');
    
    sseService.addCustomerConnection(orderId, reply.raw);

    request.raw.on('close', () => {
        sseService.removeCustomerConnection(orderId, reply.raw);
    });
};

exports.externalCheckout = async (request, reply) => {
    const apiKey = request.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.EXTERNAL_API_KEY) {
        return reply.status(401).send({ success: false, message: 'Unauthorized webhook access.' });
    }

    try {
        const newOrder = await orderService.processExternalCheckout(request.body);
        
        const payload = JSON.stringify({ type: 'NEW_ORDER', order: newOrder, source: request.body.source });
        sseService.publishEvent('admin', payload, { storeId: request.body.storeId });

        if (request.server.broadcastToPOS) {
            request.server.broadcastToPOS({ type: 'NEW_ORDER', orderId: newOrder._id, source: request.body.source, storeId: request.body.storeId });
        }

        return { success: true, message: `External Order Accepted from ${request.body.source}`, orderId: newOrder._id, orderNumber: newOrder.orderNumber };
    } catch (error) {
        if (error.statusCode === 400) return reply.status(400).send({ success: false, message: error.message });
        request.server.log.error('External Checkout Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error processing external checkout' });
    }
};

exports.onlineCheckout = async (request, reply) => {
    try {
        const newOrder = await orderService.processOnlineCheckout(request.body);
        
        const payload = JSON.stringify({ type: 'NEW_ORDER', order: newOrder });
        sseService.publishEvent('admin', payload, { storeId: request.body.storeId });

        if (request.server.broadcastToPOS) {
            request.server.broadcastToPOS({ type: 'NEW_ORDER', orderId: newOrder._id, storeId: request.body.storeId });
        }

        return { success: true, message: 'Order Placed Successfully', orderId: newOrder._id };
    } catch (error) {
        if (error.statusCode === 400) return reply.status(400).send({ success: false, message: error.message });
        request.server.log.error('Checkout Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error processing checkout' });
    }
};

exports.posCheckout = async (request, reply) => {
    try {
        const newOrder = await orderService.processPosCheckout(request.body);

        if (request.server.broadcastToPOS) {
            request.server.broadcastToPOS({ type: 'NEW_ORDER', orderId: newOrder._id, source: 'POS', storeId: request.body.storeId });
        }

        return { success: true, message: 'POS Transaction Complete', orderId: newOrder._id, orderData: newOrder };
    } catch (error) {
        if (error.statusCode === 400) return reply.status(400).send({ success: false, message: error.message });
        request.server.log.error('POS Checkout Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error processing POS transaction' });
    }
};

exports.assignDriver = async (request, reply) => {
    try {
        const { driverName, driverPhone } = request.body;
        const order = await Order.findByIdAndUpdate(
            request.params.id, 
            { deliveryDriverName: driverName, driverPhone: driverPhone || '' }, 
            { new: true }
        );
        
        if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });
        return { success: true, data: order, message: 'Driver assigned successfully' };
    } catch (error) {
        request.server.log.error('Driver Assignment Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error assigning driver' });
    }
};

exports.updateStatus = async (request, reply) => {
    try {
        const { status } = request.body;
        const order = await Order.findByIdAndUpdate(request.params.id, { status: status }, { new: true });
        
        if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });

        const payload = JSON.stringify({ type: 'STATUS_UPDATE', status: status });
        sseService.publishEvent('customer', payload, { orderId: order._id });

        if (request.server.broadcastToPOS) {
            request.server.broadcastToPOS({ type: 'ORDER_STATUS_UPDATED', orderId: order._id, status: status, storeId: order.storeId });
        }

        return { success: true, data: order };
    } catch (error) {
        request.server.log.error('Status Update Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error updating status' });
    }
};

exports.dispatchOrder = async (request, reply) => {
    try {
        const order = await Order.findByIdAndUpdate(request.params.id, { status: 'Dispatched' }, { new: true });
        if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });

        const payload = JSON.stringify({ type: 'STATUS_UPDATE', status: 'Dispatched' });
        sseService.publishEvent('customer', payload, { orderId: order._id });

        if (request.server.broadcastToPOS) request.server.broadcastToPOS({ type: 'ORDER_STATUS_UPDATED', orderId: order._id, status: 'Dispatched', storeId: order.storeId });

        return { success: true, data: order };
    } catch (error) {
        request.server.log.error('Dispatch Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error dispatching order' });
    }
};

exports.partialRefund = async (request, reply) => {
    try {
        const order = await orderService.processPartialRefund(request.params.id, request.body, request.user);
        return { success: true, message: 'Item Partially Refunded', data: order };
    } catch (error) {
        if (error.statusCode === 404) return reply.status(404).send({ success: false, message: error.message });
        request.server.log.error('Partial Refund Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error processing refund' });
    }
};

exports.cancelOrder = async (request, reply) => {
    try {
        const order = await orderService.processCancelOrder(request.params.id, request.body.reason, request.user);
        
        const payload = JSON.stringify({ type: 'STATUS_UPDATE', status: 'Cancelled' });
        sseService.publishEvent('customer', payload, { orderId: order._id });

        if (request.server.broadcastToPOS) request.server.broadcastToPOS({ type: 'ORDER_STATUS_UPDATED', orderId: order._id, status: 'Cancelled', storeId: order.storeId });

        return { success: true, message: 'Order Cancelled and Stock Refunded', data: order };
    } catch (error) {
        if (error.statusCode === 404) return reply.status(404).send({ success: false, message: error.message });
        request.server.log.error('Cancel Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error cancelling order' });
    }
};

exports.getAnalytics = async (request, reply) => {
    try {
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
    } catch (error) {
        request.server.log.error('Analytics Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error fetching analytics' });
    }
};

exports.getOrders = async (request, reply) => {
    try {
        let filter = {};
        if (request.query.tab === 'Instant') filter.deliveryType = { $ne: 'Routine' };
        if (request.query.tab === 'Routine') filter.deliveryType = 'Routine';

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
        const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        if (request.query.dateFilter === 'Today') filter.createdAt = { $gte: today };
        else if (request.query.dateFilter === 'Yesterday') filter.createdAt = { $gte: yesterday, $lt: today };
        else if (request.query.dateFilter === '7Days') filter.createdAt = { $gte: sevenDaysAgo };

        const page = parseInt(request.query.page) || 1;
        const limit = parseInt(request.query.limit);

        let query = Order.find(filter).sort({ createdAt: -1 });
        if (limit) query = query.skip((page - 1) * limit).limit(limit);

        const [orders, total, pendingOrders] = await Promise.all([
            query.lean(), Order.countDocuments(filter), Order.find({ status: { $in: ['Order Placed', 'Packing'] } }).lean()
        ]);

        return { 
            success: true, count: orders.length, total: total, data: orders,
            stats: { pendingCount: pendingOrders.length, pendingRevenue: pendingOrders.reduce((sum, o) => sum + o.totalAmount, 0) }
        };
    } catch (error) {
        request.server.log.error('Fetch Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error fetching orders' });
    }
};

exports.exportOrders = async (request, reply) => {
    try {
        const orders = await Order.find().sort({ createdAt: -1 }).lean();
        const exportData = orders.map(o => ({
            OrderID: o.orderNumber || o._id.toString(), Date: new Date(o.createdAt).toLocaleString(),
            CustomerName: o.customerName, Phone: o.customerPhone, TotalAmount: o.totalAmount,
            Status: o.status, PaymentMethod: o.paymentMethod, DeliveryType: o.deliveryType
        }));

        const csv = new Parser().parse(exportData);
        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="orders_export_${new Date().toISOString().split('T')[0]}.csv"`);
        return reply.send(csv);
    } catch (error) {
        request.server.log.error('Export Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error exporting orders' });
    }
};

exports.getOrderById = async (request, reply) => {
    try {
        const order = await Order.findById(request.params.id).lean();
        if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });
        return { success: true, data: order };
    } catch (error) {
        request.server.log.error('Tracking Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error fetching order status' });
    }
};
