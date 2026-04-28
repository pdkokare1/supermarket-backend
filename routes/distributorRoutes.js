/* routes/distributorRoutes.js */
'use strict';

const distributorController = require('../controllers/distributorController');

async function distributorRoutes(fastify, options) {
    // Existing Routes
    fastify.get('/api/distributors', { preHandler: [fastify.authenticate] }, distributorController.getAllDistributors);
    fastify.post('/api/distributors', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, distributorController.createDistributor);
    fastify.post('/api/distributors/:id/pay', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, distributorController.logPayment);

    // --- NEW: PHASE 3 B2B PORTAL ROUTES ---
    // Endpoint for distributors to pull their incoming orders from local shops
    fastify.get('/api/distributors/:id/orders', { preHandler: [fastify.authenticate] }, distributorController.getDistributorPOs);
    
    // Endpoint for distributors to update the dispatch status of a B2B order
    fastify.put('/api/distributors/orders/:orderId/status', { preHandler: [fastify.authenticate] }, distributorController.updatePurchaseOrderStatus);
}

module.exports = distributorRoutes;
