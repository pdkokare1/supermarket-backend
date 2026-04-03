/* routes/distributorRoutes.js */
const distributorController = require('../controllers/distributorController');

const distributorSchema = { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } };
const distributorPaymentSchema = { schema: { body: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', minimum: 1 }, paymentMode: { type: 'string' }, referenceNote: { type: 'string' } } } } };

async function distributorRoutes(fastify, options) {
    fastify.get('/api/distributors', { preHandler: [fastify.authenticate] }, distributorController.getDistributors);
    fastify.post('/api/distributors', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...distributorSchema }, distributorController.createDistributor);
    fastify.post('/api/distributors/:id/pay', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...distributorPaymentSchema }, distributorController.processPayment);
}
module.exports = distributorRoutes;
