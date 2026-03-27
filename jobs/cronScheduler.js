/* jobs/cronScheduler.js */

const cron = require('node-cron');
const tasks = require('./cronTasks');

module.exports = function(fastify, updateInventoryReport) {
    
    cron.schedule('0 0 * * *', () => {
        tasks.runWithLock('ExpiryWastageMonitor', fastify, () => tasks.runExpiryMonitor(fastify));
    });

    cron.schedule('0 3 * * *', () => {
        tasks.runWithLock('DataRetentionCleanup', fastify, () => tasks.runDataRetentionCleanup(fastify));
    });

    cron.schedule('0 6 * * *', () => {
        tasks.runWithLock('RoutineDeliveries', fastify, () => tasks.runRoutineDeliveries(fastify));
    });

    cron.schedule('0 9 * * *', () => {
        tasks.runWithLock('DailyInventory', fastify, () => tasks.runDailyInventory(fastify, updateInventoryReport));
    });

    cron.schedule('59 23 * * *', () => {
        tasks.runWithLock('EODBackup', fastify, () => tasks.runEODBackup(fastify));
    });

    cron.schedule('0 2 * * *', () => {
        tasks.runWithLock('CloudinaryCleanup', fastify, () => tasks.runCloudinaryCleanup(fastify));
    });
    
};
