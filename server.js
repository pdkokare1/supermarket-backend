/* server.js */
'use strict';

// OPTIMIZATION: Load environment variables absolutely first so all subsequent modules have access.
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

// ============================================================================
// --- NEW: PHASE 23 DEVOPS TELEMETRY (SENTRY CRASH REPORTING) ---
// ============================================================================
try {
    const Sentry = require("@sentry/node");
    if (process.env.SENTRY_DSN) {
        Sentry.init({
            dsn: process.env.SENTRY_DSN,
            environment: process.env.NODE_ENV || 'development',
            tracesSampleRate: 0.2, // Capture 20% of transactions for performance monitoring without overloading
        });
        console.log('[TELEMETRY] Sentry Crash Reporting initialized.');
    }
} catch (e) {
    console.warn('[TELEMETRY] @sentry/node module not installed. Skipping crash reporting initialization to prevent server crash.');
}

const connectDB = require('./config/db');
const mongoose = require('mongoose'); // Needed for graceful shutdown
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
// --- ENTERPRISE GRACEFUL SHUTDOWN ---
// ==========================================
const gracefulShutdown = async (signal) => {
    fastify.log.info(`[SHUTDOWN] Received ${signal}. Initiating graceful shutdown sequence...`);
    fastify.isShuttingDown = true; // Alerts /api/system/metrics to return 503 so load balancers stop sending traffic
    
    // Give cloud load balancers (Railway) time to reroute new traffic
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    try {
        await fastify.close();
        fastify.log.info('[SHUTDOWN] Server closed. No new HTTP connections accepted. Active requests finished.');
        
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect();
            fastify.log.info('[SHUTDOWN] MongoDB disconnected cleanly.');
        }
        
        if (redisClient) {
            await redisClient.quit();
            fastify.log.info('[SHUTDOWN] Redis disconnected cleanly.');
        }
        
        process.exit(0);
    } catch (err) {
        fastify.log.error(`[SHUTDOWN] Error during shutdown sequence: ${err.message}`);
        process.exit(1);
    }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ==========================================
// --- EXECUTION BOOTSTRAP ---
// ==========================================

bootstrapServer(fastify, redisClient, PORT, connectDB, initScheduler, startServer);
