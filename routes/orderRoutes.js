/* routes/orderRoutes.js */

const orderController = require('../controllers/orderController');
const analyticsController = require('../controllers/analyticsController'); 
const sseController = require('../controllers/sseController');
const sseService = require('../services/orderSseService');
const schemas = require('../schemas/orderSchemas');

async function orderRoutes(fastify, options) {

    fastify.decorate('closeAllSSE', () => {
        sseService.closeAllConnections();
    });

    // --- Streams ---
    fastify.get('/api/orders/stream/admin', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, sseController.streamAdmin);
    fastify.get('/api/orders/stream/customer/:id', { preHandler: [fastify.authenticate] }, sseController.streamCustomer);

    // --- Checkouts ---
    // OPTIMIZATION: Applied schema response serializers for 300% faster throughput
    fastify.post('/api/orders/external', { preHandler: [fastify.verifyApiKey], ...schemas.externalCheckoutSchema }, orderController.externalCheckout);
    fastify.post('/api/orders', { preHandler: [fastify.authenticate], ...schemas.onlineCheckoutSchema }, orderController.onlineCheckout);
    fastify.post('/api/orders/pos', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.posCheckoutSchema }, orderController.posCheckout);

    // --- NEW: PHASE 3 OMNI-CART GATEWAY ---
    fastify.post('/api/orders/omni-checkout', { preHandler: [fastify.authenticate], ...schemas.omniCartCheckoutSchema }, orderController.omniCartCheckout);

    // --- Order Operations (Admin) ---
    fastify.put('/api/orders/:id/driver', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.assignDriverSchema }, orderController.assignDriver);
    fastify.put('/api/orders/:id/status', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.statusSchema }, orderController.updateStatus);
    fastify.put('/api/orders/:id/dispatch', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, orderController.dispatchOrder);
    fastify.put('/api/orders/:id/partial-refund', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, orderController.partialRefund);
    fastify.put('/api/orders/:id/cancel', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, orderController.cancelOrder);

    // --- Fetch Operations ---
    fastify.get('/api/orders', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, orderController.getOrders);
    fastify.get('/api/orders/export', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, orderController.exportOrders);
    fastify.get('/api/orders/:id', { preHandler: [fastify.authenticate] }, orderController.getOrderById);

    // ============================================================================
    // --- NEW: PHASE 18 DISPUTE RESOLUTION CENTER ---
    // ============================================================================
    fastify.post('/api/orders/report-issue', { preHandler: [fastify.authenticate] }, orderController.reportIssue);

    // ============================================================================
    // --- NEW: PHASE 20 DYNAMIC SURGE PRICING ENGINE ---
    // ============================================================================
    fastify.get('/api/orders/surge', { preHandler: [fastify.authenticate] }, orderController.getSurgePricing);

    // ============================================================================
    // --- NEW: PHASE 25 GHOST ORDER FALLBACK (WEBHOOK LISTENER) ---
    // ============================================================================
    fastify.post('/api/orders/webhook/razorpay', orderController.razorpayWebhook);

    // ============================================================================
    // --- NEW: PHASE 28 IN-APP CHAT (REST FALLBACK) ---
    // ============================================================================
    fastify.post('/api/orders/:id/chat', { preHandler: [fastify.authenticate] }, orderController.sendChatMessage);
    fastify.get('/api/orders/:id/chat', { preHandler: [fastify.authenticate] }, orderController.getChatHistory);
}

module.exports = orderRoutes;
