/* controllers/auditController.js */
const AuditLog = require('../models/AuditLog'); // Kept simple as it's a single read

exports.getAuditLogs = async (request, reply) => {
    const limit = parseInt(request.query.limit) || 100;
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(limit).lean();
    return { success: true, data: logs };
};
