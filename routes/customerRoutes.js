/* routes/customerRoutes.js */

const customerController = require('../controllers/customerController');
const schemas = require('../schemas/customerSchemas');

async function customerRoutes(fastify, options) {
    fastify.get('/api/orders/customers', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, customerController.getCustomersFromOrders);
    fastify.get('/api/customers/export', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, customerController.exportCustomers);
    fastify.get('/api/customers/profile/:phone', { preHandler: [fastify.authenticate] }, customerController.getProfile);
    fastify.put('/api/customers/profile/:phone/limit', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.limitSchema }, customerController.updateLimit);
    fastify.post('/api/customers/profile/:phone/pay', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.paySchema }, customerController.recordPayment);
    fastify.get('/api/customers', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, customerController.getAllCustomers);
}

module.exports = customerRoutes;
