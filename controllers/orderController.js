/* controllers/orderController.js */

const orderService = require('../services/orderService'); 
const checkoutService = require('../services/checkoutService'); 
const catchAsync = require('../utils/catchAsync');
const { sendCsvResponse } = require('../utils/csvUtils'); 

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

const handleOrderResponse = (reply, order, successMessage = null) => {
    if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });
    const response = { success: true, data: order };
    if (successMessage) response.message = successMessage;
    return response;
};

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.externalCheckout = catchAsync(async (request, reply) => {
    const apiKey = request.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.EXTERNAL_API_KEY) {
        return reply.status(401).send({ success: false, message: 'Unauthorized webhook access.' });
    }
    const newOrder = await checkoutService.processExternalCheckout(request.body);
    
    return { success: true, message: `External Order Accepted from ${request.body.source}`, orderId: newOrder._id, orderNumber: newOrder.orderNumber };
}, 'processing external checkout');

exports.onlineCheckout = catchAsync(async (request, reply) => {
    const newOrder = await checkoutService.processOnlineCheckout(request.body);
    
    return { success: true, message: 'Order Placed Successfully', orderId: newOrder._id };
}, 'processing checkout');

exports.posCheckout = catchAsync(async (request, reply) => {
    const newOrder = await checkoutService.processPosCheckout(request.body);
    
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
    const exportData = await orderService.getAllOrdersForExport();
    return sendCsvResponse(reply, exportData, 'orders');
}, 'exporting orders');

exports.getOrderById = catchAsync(async (request, reply) => {
    const order = await orderService.getOrderById(request.params.id);
    return handleOrderResponse(reply, order);
}, 'fetching order status');
