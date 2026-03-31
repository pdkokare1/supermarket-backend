/* controllers/orderController.js */

const Order = require('../models/Order');
const { Parser } = require('json2csv'); 
const sseService = require('../services/orderSseService');
const orderService = require('../services/orderService'); 

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

const notifyNewOrder = (request, order, storeId, source = null) => {
    const payloadObj = { type: 'NEW_ORDER', order };
    if (source) payloadObj.source = source;
    
    sseService.publishEvent('admin', JSON.stringify(payloadObj), { storeId });

    if (request.server.broadcastToPOS) {
        const posPayload = { type: 'NEW_ORDER', orderId: order._id, storeId };
        if (source) posPayload.source = source;
        request.server.broadcastToPOS(posPayload);
    }
};

const notifyStatusUpdate = (request, orderId, status, storeId) => {
    const payload = JSON.stringify({ type: 'STATUS_UPDATE', status });
    sseService.publishEvent('customer', payload, { orderId });

    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'ORDER_STATUS_UPDATED', orderId, status, storeId });
    }
};

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
        notifyNewOrder(request, newOrder, request.body.storeId, request.body.source);
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
        notifyNewOrder(request, newOrder, request.body.storeId);
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

        notifyStatusUpdate(request, order._id, status, order.storeId);
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

        notifyStatusUpdate(request, order._id, 'Dispatched', order.storeId);
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
        
        notifyStatusUpdate(request, order._id, 'Cancelled', order.storeId);
        return { success: true, message: 'Order Cancelled and Stock Refunded', data: order };
    } catch (error) {
        if (error.statusCode === 404) return reply.status(404).send({ success: false, message: error.message });
        request.server.log.error('Cancel Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error cancelling order' });
    }
};

exports.getAnalytics = async (request, reply) => {
    try {
        return await orderService.getAnalyticsData();
    } catch (error) {
        request.server.log.error('Analytics Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error fetching analytics' });
    }
};

exports.getOrders = async (request, reply) => {
    try {
        return await orderService.getOrdersList(request.query);
    } catch (error) {
        request.server.log.error('Fetch Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error fetching orders' });
    }
};

exports.exportOrders = async (request, reply) => {
    try {
        const exportData = await orderService.getAllOrdersForExport();
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
