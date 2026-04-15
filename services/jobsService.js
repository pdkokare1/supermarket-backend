/* services/jobsService.js */
'use strict';

const Order = require('../models/Order');
const cacheUtils = require('../utils/cacheUtils');

// ==========================================
// --- ASYNC TASK QUEUE (EVENT LOOP PROTECTION) ---
// ==========================================

exports.enqueueTask = async (taskType, payload) => {
    const redis = cacheUtils.getClient();
    if (redis) {
        await redis.lpush('DAILYPICK_JOBS_QUEUE', JSON.stringify({ taskType, payload, timestamp: Date.now(), retryCount: 0 }));
    } else {
        // Fallback for local dev environments without Redis
        setImmediate(() => exports.processTask(taskType, payload, 0));
    }
};

// OPTIMIZATION: Dead Letter Queue (DLQ) routing for failed heavy tasks
const routeToDeadLetterQueue = async (taskType, payload, errorMsg) => {
    const redis = cacheUtils.getClient();
    if (redis) {
        await redis.lpush('DAILYPICK_DEAD_LETTER_QUEUE', JSON.stringify({ taskType, payload, error: errorMsg, failedAt: Date.now() }));
        console.error(`[DLQ] Task ${taskType} permanently failed and moved to Dead Letter Queue.`);
    }
};

exports.processTask = async (taskType, payload, retryCount = 0) => {
    try {
        const notificationService = require('./notificationService');
        
        if (taskType === 'EMAIL') {
            await notificationService.executeAdminEmail(null, payload.subject, payload.htmlContent, payload.textContent, payload.attachments);
        } else if (taskType === 'WHATSAPP') {
            await notificationService.executeWhatsAppMessage(payload.phone, payload.messageText, null);
        } else if (taskType === 'EXPORT_ORDERS') {
            const orderService = require('./orderService');
            const dataStream = orderService.getAllOrdersForExport();
            
            let csvContent = '';
            let isFirst = true;

            for await (const chunk of dataStream) {
                if (isFirst) {
                    csvContent += Object.keys(chunk).join(',') + '\n';
                    isFirst = false;
                }
                csvContent += Object.values(chunk).map(v => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n';
            }

            await notificationService.executeAdminEmail(
                null,
                '🔒 Your Orders Export is Ready',
                '<p>Your requested background data export has completed successfully. Please find the CSV attached.</p>',
                'Attached is the CSV export.',
                [{ filename: 'orders_export.csv', content: csvContent }]
            );
        }
    } catch (e) {
        console.error(`[BACKGROUND WORKER] Task ${taskType} Failed on attempt ${retryCount + 1}:`, e);
        
        // OPTIMIZATION: Exponential backoff for resilient retry of long-running tasks
        if (retryCount < 3) {
            const delayMs = Math.pow(2, retryCount) * 5000; // 5s, 10s, 20s
            console.log(`[BACKGROUND WORKER] Re-queuing ${taskType} in ${delayMs}ms...`);
            setTimeout(() => {
                const redis = cacheUtils.getClient();
                if (redis) {
                    redis.lpush('DAILYPICK_JOBS_QUEUE', JSON.stringify({ taskType, payload, timestamp: Date.now(), retryCount: retryCount + 1 }));
                } else {
                    exports.processTask(taskType, payload, retryCount + 1);
                }
            }, delayMs);
        } else {
            await routeToDeadLetterQueue(taskType, payload, e.message);
        }
    }
};

// OPTIMIZATION: Auto-starting the background worker to continuously poll for new queue items.
// We check cluster.isPrimary to ensure only the primary node (or a dedicated worker flag) handles polling,
// preventing worker thread starvation in clustered environments.
setTimeout(() => {
    const cluster = require('node:cluster');
    
    // Only run the poller on the primary process, OR if explicitly enabled via ENV to run on a specific worker.
    if (!cluster.isPrimary && process.env.ENABLE_WORKER_POLLING !== 'true') {
        return; 
    }

    const redis = cacheUtils.getClient();
    if (!redis) return;

    const processNext = async () => {
        try {
            // Block for up to 5 seconds waiting for a job to avoid CPU spinning
            const result = await redis.brpop('DAILYPICK_JOBS_QUEUE', 5);
            if (result) {
                const job = JSON.parse(result[1]);
                await exports.processTask(job.taskType, job.payload, job.retryCount || 0);
            }
        } catch (e) {
            console.error('[BACKGROUND WORKER] Polling Error:', e);
        }
        setTimeout(processNext, 100); 
    };
    processNext();
}, 5000);

// ==========================================
// --- EXISTING ROUTINE JOBS ---
// ==========================================

/**
 * Deletes cancelled orders older than the specified number of days.
 */
exports.deleteOldCancelledOrders = async (days) => {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - days);
    return await Order.deleteMany({ status: 'Cancelled', createdAt: { $lt: targetDate } });
};

/**
 * Scans for 'Routine' delivery type orders and generates active 'Instant' orders for the day.
 */
exports.generateRoutineDeliveries = async () => {
    const routineOrders = await Order.find({ deliveryType: 'Routine', status: { $ne: 'Cancelled' } }).lean();
    if (routineOrders.length > 0) {
        const bulkOps = routineOrders.map(ro => ({
            insertOne: {
                document: {
                    customerName: ro.customerName, 
                    customerPhone: ro.customerPhone,
                    deliveryAddress: ro.deliveryAddress, 
                    items: ro.items,
                    totalAmount: ro.totalAmount, 
                    paymentMethod: ro.paymentMethod,
                    deliveryType: 'Instant', 
                    scheduleTime: 'Generated via Routine', 
                    status: 'Order Placed'
                }
            }
        }));
        await Order.bulkWrite(bulkOps);
    }
    return routineOrders.length;
};
