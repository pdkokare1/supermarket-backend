/* routes/analyticsRoutes.js */
const analyticsController = require('../controllers/analyticsController');

async function analyticsRoutes(fastify, options) {
    fastify.get('/api/analytics/pnl', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, analyticsController.getPnl);
    fastify.post('/api/analytics/forecast', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, analyticsController.getForecast);
    fastify.get('/api/analytics/leaderboard', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, analyticsController.getLeaderboard);
}
module.exports = analyticsRoutes;
