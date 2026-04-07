/* services/auditService.js */

const AuditLog = require('../models/AuditLog');

// OPTIMIZED: Added structured pagination and strict memory projection specifically to handle fetching large audit logs
exports.getAuditLogs = async (queryParams) => {
    const page = parseInt(queryParams.page) || 1;
    const limit = parseInt(queryParams.limit) || 50;
    const skip = (page - 1) * limit;
    
    let filter = {};
    if (queryParams.targetType) filter.targetType = queryParams.targetType;
    if (queryParams.username) filter.username = queryParams.username;
    if (queryParams.action) filter.action = queryParams.action;

    // By enforcing .select() and .lean(), we drastically drop the backend RAM needed to process thousands of audit logs
    const logs = await AuditLog.find(filter)
        .select('action targetType targetId username createdAt details')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

    const total = await AuditLog.countDocuments(filter);

    return {
        success: true,
        count: logs.length,
        total,
        data: logs
    };
};

exports.logEvent = async ({ action, targetType, targetId, username, details = {}, userId = null, session = null, logError = null }) => {
    const logEntry = { 
        action, 
        targetType, 
        targetId, 
        username: username || 'Unknown' 
    };
    
    if (Object.keys(details).length > 0) logEntry.details = details;
    if (userId) logEntry.userId = userId;

    try {
        if (session) {
            await AuditLog.create([logEntry], { session });
        } else {
            await AuditLog.create(logEntry);
        }
    } catch (error) {
        if (logError) {
            logError('AuditLog Error:', error);
        } else {
            console.error('AuditLog Error:', error);
        }
    }
};

// --- NEW ABSTRACTIONS FOR CRON JOBS ---
exports.deleteOldAuditLogs = async (days) => {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - days);
    
    if (!AuditLog) return { deletedCount: 0 };
    return await AuditLog.deleteMany({ createdAt: { $lt: targetDate } });
};
