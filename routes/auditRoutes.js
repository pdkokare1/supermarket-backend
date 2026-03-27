/* routes/auditRoutes.js */

const AuditLog = require('../models/AuditLog');

async function auditRoutes(fastify, options) {
    // Fetch recent audit logs (Admin Only)
    fastify.get('/api/audit', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const limit = parseInt(request.query.limit) || 100;
            const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(limit).lean();
            return { success: true, data: logs };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching audit logs' });
        }
    });
}

module.exports = auditRoutes;
