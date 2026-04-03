/* routes/auditRoutes.js */
const auditController = require('../controllers/auditController');

async function auditRoutes(fastify, options) {
    fastify.get('/api/audit', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, auditController.getAuditLogs);
}
module.exports = auditRoutes;
