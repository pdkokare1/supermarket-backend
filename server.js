/* server.js */
'use strict';

// OPTIMIZATION: Load environment variables absolutely first so all subsequent modules have access.
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const connectDB = require('./config/db');
const { handleInventoryReport } = require('./jobs/inventoryHandler'); 
const { bootstrapServer } = require('./utils/serverProcessUtils');
const createApp = require('./app');

// ==========================================
// --- WORKER PROCESS EXECUTION ---
// ==========================================

const { fastify, redisClient } = createApp();
const PORT = process.env.PORT || 3000;

// ==========================================
// --- ENTERPRISE PROCESS STABILITY ---
// ==========================================

process.on('unhandledRejection', (err) => {
    fastify.log.error(`UNHANDLED REJECTION: ${err.message}`);
    if (fastify.log.flushSync) {
        fastify.log.flushSync();
    }
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    fastify.log.error(`UNCAUGHT EXCEPTION: ${err.message}`);
    
    // OPTIMIZATION: Ensure asynchronous Pino logs are written to the cloud stream before sudden container termination.
    if (fastify.log.flushSync) {
        fastify.log.flushSync();
    }
    
    process.exit(1);
});

// OPTIMIZATION: Catch container termination signals to trigger graceful server drain.
let isShuttingDown = false; // Lock to prevent double execution
const shutdownSignalHandler = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    fastify.log.info(`Worker ${process.pid} received ${signal}. Stopping new traffic and completing active checkouts...`);
    
    // Failsafe: Prevent container orchestration platforms from executing a hard unlogged kill.
    const killTimer = setTimeout(() => {
        fastify.log.error('Graceful shutdown drain timeout exceeded. Forcing process exit.');
        if (fastify.log.flushSync) fastify.log.flushSync();
        process.exit(1);
    }, 10000);

    try {
        await fastify.close(); // Triggers the onClose hook in app.js natively after draining
        clearTimeout(killTimer); // OPTIMIZATION: Clear the timer explicitly to free up the event loop
        process.exit(0);
    } catch (err) {
        clearTimeout(killTimer);
        fastify.log.error(`Error during graceful shutdown: ${err.message}`);
        process.exit(1);
    }
};

process.on('SIGINT', () => shutdownSignalHandler('SIGINT'));
process.on('SIGTERM', () => shutdownSignalHandler('SIGTERM'));

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
    require('./jobs/backupCron')(fastify); 
    
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        fastify.log.info(`DailyPick backend ${process.pid} successfully bound to port ${PORT}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// ==========================================
// --- EXECUTION BOOTSTRAP ---
// ==========================================

bootstrapServer(fastify, redisClient, PORT, connectDB, initScheduler, startServer);
