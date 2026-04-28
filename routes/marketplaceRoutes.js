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

    // --- NEW: PHASE 2 STORE-IN-STORE AGGREGATOR ---
    // GET /api/marketplace/storefront/:storeId -> Fetches a specific enterprise's local inventory
    fastify.get('/api/marketplace/storefront/:storeId', marketplaceController.getStorefront);

    // --- NEW: PHASE 2 CROSS-STORE PRICE ENGINE ---
    // GET /api/marketplace/compare -> Returns pricing from all nearby stores for a given SKU
    fastify.get('/api/marketplace/compare', marketplaceController.comparePrices);
}

module.exports = marketplaceRoutes;
