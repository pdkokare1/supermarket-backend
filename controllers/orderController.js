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
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    const newOrder = await withTransaction(async (session) => {
        return await checkoutService.processExternalCheckout(payload, session);
    });
    reply.code(201);
    return { success: true, message: `External Order Accepted from ${request.body.source}`, orderId: newOrder._id, orderNumber: newOrder.orderNumber };
};

exports.onlineCheckout = async (request, reply) => {
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    const newOrder = await withTransaction(async (session) => {
        return await checkoutService.processOnlineCheckout(payload, session);
    });
    reply.code(201);
    return { success: true, message: 'Order Placed Successfully', orderId: newOrder._id };
};

exports.posCheckout = async (request, reply) => {
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
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
    let order = await orderService.updateOrderStatus(request.params.id, status);

    // AUTOMATED LAST-MILE LOGISTICS TRIGGER
    if (status === 'Packed' && process.env.ENABLE_LOGISTICS_AUTOMATION === 'true') {
        try {
            const mockDriver = {
                name: "Auto Rider (Shadowfax Sandbox)",
                phone: "+91 99999 00000",
                trackingId: `SFX-${Math.floor(Math.random() * 1000000)}`
            };
            order = await orderService.assignDriverToOrder(request.params.id, mockDriver.name, mockDriver.phone);
            order.trackingLink = `https://track.shadowfax.in/${mockDriver.trackingId}`;
        } catch (error) {
            request.server.log.error(`Logistics Sandbox Error: ${error.message}`);
        }
    }
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

// ==========================================
// --- NEW: PHASE 3 OMNI-CART CHECKOUT ---
// ==========================================

exports.omniCartCheckout = async (request, reply) => {
    // Handles a single transaction containing items from multiple independent stores
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    
    // Payload expectation: payload.carts = [{ storeId: "DMART", items: [...] }, { storeId: "KIRANA", items: [...] }]
    if (!payload.carts || !Array.isArray(payload.carts)) {
        throw new AppError('Omni-Cart requires an array of store-specific carts.', 400);
    }

    const splitShipmentGroupId = `OMNI-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    let masterCartTotalRs = 0;
    const generatedOrders = [];

    await withTransaction(async (session) => {
        for (const storeCart of payload.carts) {
            // Re-map the payload to utilize existing checkout architecture silently
            const subPayload = {
                ...payload,
                storeId: storeCart.storeId,
                items: storeCart.items,
                idempotencyKey: `${payload.idempotencyKey}-${storeCart.storeId}`,
                splitShipmentGroupId: splitShipmentGroupId // Groups them together
            };
            
            // Send sub-order to existing trusted checkout service
            const newOrder = await checkoutService.processOnlineCheckout(subPayload, session);
            masterCartTotalRs += newOrder.totalAmount; // Accumulate Rs total
            generatedOrders.push(newOrder);
        }
        
        // Once all individual store sub-orders are secure, stamp them with the Unified Total
        if (generatedOrders.length > 0) {
            const Order = require('../models/Order');
            await Order.updateMany(
                { splitShipmentGroupId: splitShipmentGroupId },
                { $set: { masterCartTotalRs: masterCartTotalRs } },
                { session }
            );
        }
    });

    reply.code(201);
    return { 
        success: true, 
        message: 'Omni-Cart Checkout Complete', 
        splitShipmentGroupId: splitShipmentGroupId,
        masterCartTotalRs: masterCartTotalRs,
        totalShipments: generatedOrders.length
    };
};
