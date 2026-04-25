/* routes/marketplaceRoutes.js */
'use strict';

const marketplaceController = require('../controllers/marketplaceController');

async function marketplaceRoutes(fastify, options) {
    // --- FLEET TRACKING ---
    // POST /api/fleet/ping -> Updates the Delivery Agent's GPS position
    fastify.post('/api/fleet/ping', { preHandler: [fastify.authenticate] }, marketplaceController.pingLocation);

    // --- MARKETPLACE TRUST ---
    // POST /api/stores/rate -> Submits a 1-5 star review for a specific store tenant
    fastify.post('/api/stores/rate', { preHandler: [fastify.authenticate] }, marketplaceController.rateStore);
}

module.exports = marketplaceRoutes;
