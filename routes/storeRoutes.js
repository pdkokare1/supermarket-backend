/* routes/storeRoutes.js */

const storeController = require('../controllers/storeController');

async function storeRoutes(fastify, options) {
    // PUBLIC: Get all stores (Needed for login dropdowns)
    fastify.get('/api/stores', storeController.getStores);

    // ADMIN ONLY: Create a new store
    fastify.post('/api/stores', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, storeController.createStore);

    // STORE TENANT ONLY: Raise a dispute
    fastify.post('/api/stores/dispute', { preHandler: [fastify.authenticate] }, storeController.raiseDispute);

    // --- NEW: ENTERPRISE KEY GENERATOR ---
    // SUPERADMIN ONLY: Generate Webhook Key for Enterprise Partners
    fastify.post('/api/stores/:id/api-key', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, storeController.generateEnterpriseKey);
}

module.exports = storeRoutes;
