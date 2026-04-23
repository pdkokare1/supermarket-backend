/* services/auditService.js */

const AuditLog = require('../models/AuditLog');

let auditBatch = [];

// OPTIMIZED: Added structured pagination and strict memory projection specifically to handle fetching large audit logs
exports.getAuditLogs = async (queryParams) => {
    const page = parseInt(queryParams.page) || 1;
    const limit = parseInt(queryParams.limit) || 50;
    const skip = (page - 1) * limit;
    
    let filter = {};
    if (queryParams.targetType) filter.targetType = queryParams.targetType;
    if (queryParams.username) filter.username = queryParams.username;
    if (queryParams.action) filter.action = queryParams.action;

    // OPTIMIZATION: Single-pass database execution for highly scalable log fetching.
    const result = await AuditLog.aggregate([
        { $match: filter },
        { $facet: {
            metadata: [ { $count: "total" } ],
            data: [
                { $sort: { createdAt: -1 } },
                { $skip: skip },
                { $limit: limit },
                { $project: { action: 1, targetType: 1, targetId: 1, username: 1, createdAt: 1, details: 1, previousState: 1, newState: 1 } }
            ]
        }}
    ]);

    const logs = result[0].data;
    const total = result[0].metadata[0]?.total || 0;

    return {
        success: true,
        count: logs.length,
        total,
        data: logs
    };
};

// OPTIMIZATION: Expanded footprint to securely capture before/after object states
exports.logEvent = async ({ action, targetType, targetId, username, details = {}, userId = null, previousState = null, newState = null, session = null, logError = null, reqId = null, ip = null }) => {
    const logEntry = { 
        action, 
        targetType, 
        targetId, 
        username: username || 'Unknown' 
    };
    
    if (Object.keys(details).length > 0) logEntry.details = details;
    if (userId) logEntry.userId = userId;
    if (previousState) logEntry.previousState = previousState;
    if (newState) logEntry.newState = newState;
    
    // ENTERPRISE FIX: Capture the exact terminal identifier and request stream for precise forensic debugging
    if (reqId) logEntry.details.reqId = reqId;
    if (ip) logEntry.details.ip = ip;

    // DEPRECATION CONSULTATION: Awaiting synchronous database inserts slows down administrative operations
    /*
    try {
        if (session) {
            await AuditLog.create([logEntry], { session });
        } else {
            await AuditLog.create(logEntry);
        }
    } catch (error) { ... }
    */

    // OPTIMIZATION: Push to non-blocking memory array. Fastify's onResponse hook flushes this automatically.
    auditBatch.push(logEntry);
};

exports.flushAuditBatch = async () => {
    if (auditBatch.length === 0) return;
    
    // Copy and immediately clear the batch to prevent duplicate writes during concurrency
    const batchToInsert = [...auditBatch];
    auditBatch = []; 
    
    try {
        await AuditLog.insertMany(batchToInsert, { ordered: false });
    } catch (error) {
        console.error('[SECURITY] AuditLog Batch Insert Error:', error);
    }
};

// --- NEW ABSTRACTIONS FOR CRON JOBS ---
exports.deleteOldAuditLogs = async (days) => {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - days);
    
    if (!AuditLog) return { deletedCount: 0 };
    return await AuditLog.deleteMany({ createdAt: { $lt: targetDate } });
};
