/* routes/orderRoutes.js */

const orderController = require('../controllers/orderController');
const sseService = require('../services/orderSseService');
const schemas = require('../schemas/orderSchemas');

async function orderRoutes(fastify, options) {

    // Global Decorator for cleanup mapped to SSE service
    fastify.decorate('closeAllSSE', () => {
        sseService.closeAllConnections();
    });

    // --- Streams ---
    fastify.get('/api/orders/stream/admin', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, orderController.streamAdmin);
    fastify.get('/api/orders/stream/customer/:id', { preHandler: [fastify.authenticate] }, orderController.streamCustomer);

    // --- Checkouts ---
    fastify.post('/api/orders/external', { ...schemas.externalCheckoutSchema }, orderController.externalCheckout);
    fastify.post('/api/orders', { preHandler: [fastify.authenticate], ...schemas.onlineCheckoutSchema }, orderController.onlineCheckout);
    fastify.post('/api/orders/pos', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.posCheckoutSchema }, orderController.posCheckout);

    // --- Order Operations (Admin) ---
    fastify.put('/api/orders/:id/driver', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.assignDriverSchema }, orderController.assignDriver);
    fastify.put('/api/orders/:id/status', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.statusSchema }, orderController.updateStatus);
    fastify.put('/api/orders/:id/dispatch', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, orderController.dispatchOrder);
    fastify.put('/api/orders/:id/partial-refund', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, orderController.partialRefund);
    fastify.put('/api/orders/:id/cancel', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.cancelSchema }, orderController.cancelOrder);

    // --- Analytics & Fetching ---
    fastify.get('/api/orders/analytics', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, orderController.getAnalytics);
    fastify.get('/api/orders/export', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, orderController.exportOrders);
    fastify.get('/api/orders', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.getOrdersSchema }, orderController.getOrders);
    
    // --- Tracking (Customer) ---
    fastify.get('/api/orders/:id', { preHandler: [fastify.authenticate] }, orderController.getOrderById);
}

module.exports = orderRoutes;
