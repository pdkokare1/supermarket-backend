/* routes/orderRoutes.js */
'use strict';

const checkoutController = require('../controllers/checkoutController');
const logisticsController = require('../controllers/logisticsController'); 
const supportController = require('../controllers/supportController'); 
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

    // ==========================================
    // --- DOMAIN: CHECKOUTS & MONEY-IN ---
    // ==========================================
    fastify.post('/api/orders/external', { preHandler: [fastify.verifyApiKey], ...schemas.externalCheckoutSchema }, checkoutController.externalCheckout);
    fastify.post('/api/orders', { preHandler: [fastify.authenticate], ...schemas.onlineCheckoutSchema }, checkoutController.onlineCheckout);
    fastify.post('/api/orders/pos', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.posCheckoutSchema }, checkoutController.posCheckout);
    fastify.post('/api/orders/omni-checkout', { preHandler: [fastify.authenticate], ...schemas.omniCartCheckoutSchema }, checkoutController.omniCartCheckout);

    // ==========================================
    // --- DOMAIN: LOGISTICS & DISPATCH ---
    // ==========================================
    fastify.put('/api/orders/:id/driver', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.assignDriverSchema }, logisticsController.assignDriver);
    fastify.put('/api/orders/:id/status', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.statusSchema }, logisticsController.updateStatus);
    fastify.put('/api/orders/:id/dispatch', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, logisticsController.dispatchOrder);
    
    // MISSING ENDPOINT FIXED: Enables the Rider App Background Geolocation Ping
    fastify.post('/api/orders/rider/location', { preHandler: [fastify.authenticate] }, logisticsController.updateRiderLocation);
    fastify.get('/api/orders/surge', { preHandler: [fastify.authenticate] }, logisticsController.getSurgePricing);
    
    fastify.get('/api/orders', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, logisticsController.getOrders);
    fastify.get('/api/orders/export', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, logisticsController.exportOrders);
    fastify.get('/api/orders/:id', { preHandler: [fastify.authenticate] }, logisticsController.getOrderById);

    // ==========================================
    // --- DOMAIN: SUPPORT, OPS & POST-ORDER ---
    // ==========================================
    fastify.put('/api/orders/:id/partial-refund', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, supportController.partialRefund);
    fastify.put('/api/orders/:id/cancel', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, supportController.cancelOrder);
    fastify.post('/api/orders/report-issue', { preHandler: [fastify.authenticate] }, supportController.reportIssue);
    fastify.post('/api/orders/webhook/razorpay', supportController.razorpayWebhook);
    
    // In-App Chat
    fastify.post('/api/orders/:id/chat', { preHandler: [fastify.authenticate] }, supportController.sendChatMessage);
    fastify.get('/api/orders/:id/chat', { preHandler: [fastify.authenticate] }, supportController.getChatHistory);
    
    // Operations Lifeline
    fastify.put('/api/orders/:id/short-pick', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, supportController.shortPickItem);
    
    // MISSING ENDPOINT FIXED: Enables Customer Rating Submissions
    fastify.post('/api/orders/:id/rate', { preHandler: [fastify.authenticate] }, supportController.rateOrder);
}

module.exports = orderRoutes;
