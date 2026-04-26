/* routes/aiRoutes.js */
'use strict';

const aiController = require('../controllers/aiController');

async function aiRoutes(fastify, options) {
    // Enterprise AI Tools (Admin Only)
    fastify.get('/api/ai/forecast', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, aiController.generateInventoryForecast);
}

module.exports = aiRoutes;
