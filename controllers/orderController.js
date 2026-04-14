/* controllers/orderController.js */

const orderService = require('../services/orderService'); 
const checkoutService = require('../services/checkoutService'); 
const jobsService = require('../services/jobsService'); 
const catchAsync = require('../utils/catchAsync');
const { sendCsvResponse } = require('../utils/csvUtils'); 
const { handleOrderResponse } = require('../utils/responseUtils');
const { Transform } = require('stream');

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.externalCheckout = catchAsync(async (request, reply) => {
    // OPTIMIZATION: Extracting Idempotency Key from headers to prevent double-charges on network retries
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    
    // OPTIMIZATION: API Key validation moved to route middleware for separation of concerns
    const newOrder = await checkoutService.processExternalCheckout(payload);
    
    // OPTIMIZATION: Added explicit 201 Created status for enterprise REST compliance
    reply.code(201);
    return { success: true, message: `External Order Accepted from ${request.body.source}`, orderId: newOrder._id, orderNumber: newOrder.orderNumber };
}, 'processing external checkout');

exports.onlineCheckout = catchAsync(async (request, reply) => {
    // OPTIMIZATION: Secure Idempotency Injection
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    
    const newOrder = await checkoutService.processOnlineCheckout(payload);
    
    reply.code(201);
    return { success: true, message: 'Order Placed Successfully', orderId: newOrder._id };
}, 'processing checkout');

exports.posCheckout = catchAsync(async (request, reply) => {
    // OPTIMIZATION: Secure Idempotency Injection for POS endpoints
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    
    const newOrder = await checkoutService.processPosCheckout(payload);
    
    reply.code(201);
    return { success: true, message: 'POS Transaction Complete', orderId: newOrder._id, orderData: newOrder };
}, 'processing POS transaction');

exports.assignDriver = catchAsync(async (request, reply) => {
    const { driverName, driverPhone } = request.body;
    const order = await orderService.assignDriverToOrder(request.params.id, driverName, driverPhone);
    return handleOrderResponse(reply, order, 'Driver assigned successfully');
}, 'assigning driver');

exports.updateStatus = catchAsync(async (request, reply) => {
    const { status } = request.body;
    const order = await orderService.updateOrderStatus(request.params.id, status);
    return handleOrderResponse(reply, order);
}, 'updating status');

exports.dispatchOrder = catchAsync(async (request, reply) => {
    const order = await orderService.dispatchOrder(request.params.id);
    return handleOrderResponse(reply, order);
}, 'dispatching order');

exports.partialRefund = catchAsync(async (request, reply) => {
    const order = await orderService.processPartialRefund(request.params.id, request.body, request.user);
    return { success: true, message: 'Item Partially Refunded', data: order };
}, 'processing refund');

exports.cancelOrder = catchAsync(async (request, reply) => {
    const order = await orderService.processCancelOrder(request.params.id, request.body.reason, request.user);
    return { success: true, message: 'Order Cancelled and Stock Refunded', data: order };
}, 'cancelling order');

exports.getOrders = catchAsync(async (request, reply) => {
    return await orderService.getOrdersList(request.query);
}, 'fetching orders');

exports.exportOrders = catchAsync(async (request, reply) => {
    // DEPRECATION CONSULTATION: Synchronous streaming blocked the active connection until finish
    /*
    const dataStream = orderService.getAllOrdersForExport();
    const csvTransform = new Transform({ ... });
    return reply.send(dataStream.pipe(csvTransform));
    */

    // OPTIMIZATION: Asynchronous Task Queuing. Offloads heavy CSV generation to background worker.
    await jobsService.enqueueTask('EXPORT_ORDERS', { 
        email: request.user?.email || process.env.TARGET_EMAIL,
        query: request.query 
    });

    reply.code(202);
    return { success: true, message: 'Export job queued securely. You will receive the CSV via email shortly.' };
}, 'exporting orders');

exports.getOrderById = catchAsync(async (request, reply) => {
    const order = await orderService.getOrderById(request.params.id);
    return handleOrderResponse(reply, order);
}, 'fetching order status');
