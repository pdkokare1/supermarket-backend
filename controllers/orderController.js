/* controllers/orderController.js */

const orderService = require('../services/orderService'); 
const checkoutService = require('../services/checkoutService'); 
const jobsService = require('../services/jobsService'); 
const { sendCsvResponse } = require('../utils/csvUtils'); 
const { handleOrderResponse } = require('../utils/responseUtils');
const { Transform } = require('stream');
const { withTransaction } = require('../utils/dbUtils'); // OPTIMIZATION: Imported for Controller-level transaction boundaries

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.externalCheckout = async (request, reply) => {
    // OPTIMIZATION: Extracting Idempotency Key from headers to prevent double-charges on network retries
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    
    // OPTIMIZATION: API Key validation moved to route middleware for separation of concerns
    // OPTIMIZATION: Wrap in ACID Transaction
    const newOrder = await withTransaction(async (session) => {
        return await checkoutService.processExternalCheckout(payload, session);
    });
    
    // OPTIMIZATION: Added explicit 201 Created status for enterprise REST compliance
    reply.code(201);
    return { success: true, message: `External Order Accepted from ${request.body.source}`, orderId: newOrder._id, orderNumber: newOrder.orderNumber };
};

exports.onlineCheckout = async (request, reply) => {
    // OPTIMIZATION: Secure Idempotency Injection
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    
    // OPTIMIZATION: Wrap in ACID Transaction
    const newOrder = await withTransaction(async (session) => {
        return await checkoutService.processOnlineCheckout(payload, session);
    });
    
    reply.code(201);
    return { success: true, message: 'Order Placed Successfully', orderId: newOrder._id };
};

exports.posCheckout = async (request, reply) => {
    // OPTIMIZATION: Secure Idempotency Injection for POS endpoints
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    
    // OPTIMIZATION: Wrap in ACID Transaction
    const newOrder = await withTransaction(async (session) => {
        return await checkoutService.processPosCheckout(payload, session);
    });
    
    reply.code(201);
    return { success: true, message: 'POS Transaction Complete', orderId: newOrder._id, orderData: newOrder };
};

exports.assignDriver = async (request, reply) => {
    const { driverName, driverPhone } = request.body;
    const order = await orderService.assignDriverToOrder(request.params.id, driverName, driverPhone);
    return handleOrderResponse(reply, order, 'Driver assigned successfully');
};

exports.updateStatus = async (request, reply) => {
    const { status } = request.body;
    const order = await orderService.updateOrderStatus(request.params.id, status);
    return handleOrderResponse(reply, order);
};

exports.dispatchOrder = async (request, reply) => {
    const order = await orderService.dispatchOrder(request.params.id);
    return handleOrderResponse(reply, order);
};

exports.partialRefund = async (request, reply) => {
    const order = await orderService.processPartialRefund(request.params.id, request.body, request.user);
    return { success: true, message: 'Item Partially Refunded', data: order };
};

exports.cancelOrder = async (request, reply) => {
    const order = await orderService.processCancelOrder(request.params.id, request.body.reason, request.user);
    return { success: true, message: 'Order Cancelled and Stock Refunded', data: order };
};

exports.getOrders = async (request, reply) => {
    return await orderService.getOrdersList(request.query);
};

exports.exportOrders = async (request, reply) => {
    // OPTIMIZATION: Asynchronous Task Queuing. Offloads heavy CSV generation to background worker.
    await jobsService.enqueueTask('EXPORT_ORDERS', { 
        email: request.user?.email || process.env.TARGET_EMAIL,
        query: request.query 
    });

    reply.code(202);
    return { success: true, message: 'Export job queued securely. You will receive the CSV via email shortly.' };
};

exports.getOrderById = async (request, reply) => {
    const order = await orderService.getOrderById(request.params.id);
    return handleOrderResponse(reply, order);
};
