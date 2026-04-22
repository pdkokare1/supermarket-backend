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
