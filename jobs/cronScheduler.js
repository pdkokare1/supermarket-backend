/* jobs/cronScheduler.js */

const cron = require('node-cron');
const tasks = require('./cronTasks');

module.exports = function(fastify, updateInventoryReport) {
    
    // OPTIMIZATION: Track all cron tasks so they can be halted during server drain
    const scheduledTasks = [];
    
    // OPTIMIZATION: Hardened Timezone configuration ensures cloud servers on UTC run jobs at local time.
    const cronOptions = { timezone: process.env.TZ || 'Asia/Kolkata' };

    scheduledTasks.push(cron.schedule('0 0 * * *', () => {
        tasks.runWithLock('ExpiryWastageMonitor', fastify, () => tasks.runExpiryMonitor(fastify));
    }, cronOptions));

    scheduledTasks.push(cron.schedule('0 3 * * *', () => {
        tasks.runWithLock('DataRetentionCleanup', fastify, () => tasks.runDataRetentionCleanup(fastify));
    }, cronOptions));

    scheduledTasks.push(cron.schedule('0 6 * * *', () => {
        tasks.runWithLock('RoutineDeliveries', fastify, () => tasks.runRoutineDeliveries(fastify));
    }, cronOptions));

    scheduledTasks.push(cron.schedule('0 9 * * *', () => {
        tasks.runWithLock('DailyInventory', fastify, () => tasks.runDailyInventory(fastify, updateInventoryReport));
    }, cronOptions));

    scheduledTasks.push(cron.schedule('59 23 * * *', () => {
        tasks.runWithLock('EODBackup', fastify, () => tasks.runEODBackup(fastify));
    }, cronOptions));

    scheduledTasks.push(cron.schedule('0 2 * * *', () => {
        tasks.runWithLock('CloudinaryCleanup', fastify, () => tasks.runCloudinaryCleanup(fastify));
    }, cronOptions));
    
    // OPTIMIZATION: Graceful shutdown integration. Stops cron triggers while server is draining.
    fastify.addHook('onClose', async (instance, done) => {
        instance.log.info('Halting all scheduled CRON tasks for graceful shutdown...');
        scheduledTasks.forEach(task => task.stop());
        done();
    });
};

// ============================================================================
// --- NEW: PHASE 12 ALGORITHMIC RESTOCK ALERTS ---
// ============================================================================
const originalCronSchedulerPhase12 = module.exports;

module.exports = function(fastify, updateInventoryReport) {
    originalCronSchedulerPhase12(fastify, updateInventoryReport);
    
    const cron = require('node-cron');
    const cronOptions = { timezone: process.env.TZ || 'Asia/Kolkata' };
    
    // Run every 2 hours to analyze purchase velocity
    const velocityJob = cron.schedule('0 */2 * * *', async () => {
        if (fastify.isShuttingDown) return;
        
        try {
            fastify.log.info('Running Phase 12 Velocity & Restock Analyzer...');
            const Order = require('../models/Order');
            const Product = require('../models/Product');
            
            // Look at orders from the last 24 hours
            const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
            
            const velocityData = await Order.aggregate([
                { $match: { createdAt: { $gte: yesterday }, status: { $in: ['Delivered', 'Dispatched'] } } },
                { $unwind: "$items" },
                { $group: { _id: "$items.productId", dailySold: { $sum: "$items.qty" } } }
            ]);
            
            for (const stat of velocityData) {
                const product = await Product.findById(stat._id);
                if (product && product.variants && product.variants.length > 0) {
                    const stock = product.variants[0].stock;
                    // If daily velocity exceeds current stock, we will run out soon.
                    if (stat.dailySold > stock && stock > 0) {
                        fastify.log.warn(`🚨 URGENT RESTOCK: ${product.name} is draining fast! Sold ${stat.dailySold} today, only ${stock} left.`);
                    }
                }
            }
        } catch (err) {
            fastify.log.error('Velocity Analyzer Error: ' + err.message);
        }
    }, cronOptions);
    
    fastify.addHook('onClose', async (instance, done) => {
        velocityJob.stop();
        done();
    });
};
