/* routes/storeRoutes.js */

const storeController = require('../controllers/storeController');

async function storeRoutes(fastify, options) {
    // PUBLIC: Get all stores (Needed for login dropdowns)
    fastify.get('/api/stores', storeController.getStores);

    // ADMIN ONLY: Create a new store
    fastify.post('/api/stores', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, storeController.createStore);

    // --- NEW: TENANT DISPUTE ENDPOINT ---
    // STORE TENANT ONLY: Raise a dispute for a returned/damaged order to freeze automated payouts
    fastify.post('/api/stores/dispute', { preHandler: [fastify.authenticate] }, storeController.raiseDispute);
}

module.exports = storeRoutes;
