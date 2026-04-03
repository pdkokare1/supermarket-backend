const promotionController = require('../controllers/promotionController');
const promotionSchema = { /* Your exact schema from before goes here */ };
const getPromotionsSchema = { schema: { querystring: { type: 'object', properties: { all: { type: 'string' } } } } };

async function promotionRoutes(fastify, options) {
    fastify.get('/api/promotions', { preHandler: [fastify.authenticate], ...getPromotionsSchema }, promotionController.getPromotions);
    fastify.post('/api/promotions', { preHandler: [fastify.authenticate, fastify.verifyAdmin] /*, ...promotionSchema*/ }, promotionController.createPromotion);
    fastify.put('/api/promotions/:id/toggle', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, promotionController.togglePromotion);
}
module.exports = promotionRoutes;
