/* routes/analyticsRoutes.js */
const analyticsController = require('../controllers/analyticsController');

async function analyticsRoutes(fastify, options) {
    fastify.get('/api/analytics/pnl', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, analyticsController.getPnl);
    // CHANGED: fastify.post to fastify.get to match the frontend request
    fastify.get('/api/analytics/forecast', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, analyticsController.getForecast);
    fastify.get('/api/analytics/leaderboard', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, analyticsController.getLeaderboard);
}
module.exports = analyticsRoutes;
