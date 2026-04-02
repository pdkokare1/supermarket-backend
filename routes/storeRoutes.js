/* routes/storeRoutes.js */

const storeController = require('../controllers/storeController');

async function storeRoutes(fastify, options) {
    // PUBLIC: Get all stores (Needed for login dropdowns)
    fastify.get('/api/stores', storeController.getStores);

    // ADMIN ONLY: Create a new store
    fastify.post('/api/stores', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, storeController.createStore);
}

module.exports = storeRoutes;
