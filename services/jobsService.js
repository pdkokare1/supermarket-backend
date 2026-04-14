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
        await redis.lpush('GAMUT_JOBS_QUEUE', JSON.stringify({ taskType, payload, timestamp: Date.now() }));
    } else {
        // Fallback for local dev environments without Redis
        setImmediate(() => exports.processTask(taskType, payload));
    }
};

exports.processTask = async (taskType, payload) => {
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
        console.error(`[BACKGROUND WORKER] Task ${taskType} Failed:`, e);
    }
};

// OPTIMIZATION: Auto-starting the background worker to continuously poll for new queue items
setTimeout(() => {
    const redis = cacheUtils.getClient();
    if (!redis) return;

    const processNext = async () => {
        try {
            // Block for up to 5 seconds waiting for a job to avoid CPU spinning
            const result = await redis.brpop('GAMUT_JOBS_QUEUE', 5);
            if (result) {
                const job = JSON.parse(result[1]);
                await exports.processTask(job.taskType, job.payload);
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
