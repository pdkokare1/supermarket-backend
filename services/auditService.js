/* services/auditService.js */

const AuditLog = require('../models/AuditLog');

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
