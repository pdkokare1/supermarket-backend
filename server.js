/* server.js */
'use strict';

// OPTIMIZATION: Load environment variables absolutely first so all subsequent modules have access.
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const connectDB = require('./config/db');
const { handleInventoryReport } = require('./jobs/inventoryHandler'); 
const { bootstrapServer } = require('./utils/serverProcessUtils');
const setupProcessManager = require('./utils/processManager');
const createApp = require('./app');
const cron = require('node-cron'); // NEW: Imported for Phase 7 Backups
const jobsService = require('./services/jobsService'); // NEW: Imported for Phase 7 Backups

// ==========================================
// --- WORKER PROCESS EXECUTION ---
// ==========================================

const { fastify, redisClient } = createApp();
const PORT = process.env.PORT || 3000;

// Delegate enterprise stability and shutdown logic to the modular utility
setupProcessManager(fastify);

// ==========================================
// --- INITIALIZATION HELPERS ---
// ==========================================

const initScheduler = () => {
    const scheduler = require('./jobs/cronScheduler');
    scheduler(fastify, (newReport) => 
        handleInventoryReport(redisClient, fastify, newReport)
    );
};

const startServer = async () => {
    await connectDB(fastify);
    
    try {
        require('./jobs/backupCron')(fastify); 
    } catch (err) {
        // Failsafe in case file is a stub or missing
    }
    
    // NEW: Phase 7 Automated Disaster Recovery (Zero-Cost Engine)
    cron.schedule('0 2 * * *', () => {
        fastify.log.info('Triggering automated daily database backup...');
        jobsService.enqueueTask('DATABASE_BACKUP', {});
    }, { timezone: "Asia/Kolkata" });
    
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        fastify.log.info(`DailyPick backend worker ${process.pid} successfully bound to port ${PORT}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// ==========================================
// --- EXECUTION BOOTSTRAP ---
// ==========================================

bootstrapServer(fastify, redisClient, PORT, connectDB, initScheduler, startServer);
