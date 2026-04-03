/* controllers/auditController.js */
const AuditLog = require('../models/AuditLog'); // Kept simple as it's a single read
const catchAsync = require('../utils/catchAsync');

exports.getAuditLogs = catchAsync(async (request, reply) => {
    const limit = parseInt(request.query.limit) || 100;
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(limit).lean();
    return { success: true, data: logs };
}, 'fetching audit logs');
