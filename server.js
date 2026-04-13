/* server.js */
'use strict';

const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = require('./config/db');
const { handleInventoryReport } = require('./jobs/inventoryHandler'); 
const { bootstrapServer } = require('./utils/serverProcessUtils');
const createApp = require('./app');

const { fastify, redisClient } = createApp();
const PORT = process.env.PORT || 3000;

// ==========================================
// --- ENTERPRISE PROCESS STABILITY ---
// ==========================================

process.on('unhandledRejection', (err) => {
    fastify.log.error(`UNHANDLED REJECTION: ${err.message}`);
    // In production, you might want process.exit(1) here to let the cloud provider restart a clean container
});

process.on('uncaughtException', (err) => {
    fastify.log.error(`UNCAUGHT EXCEPTION: ${err.message}`);
    
    // OPTIMIZATION: Ensure asynchronous Pino logs are written to the cloud stream before sudden container termination.
    if (fastify.log.flushSync) {
        fastify.log.flushSync();
    }
    
    process.exit(1);
});

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
        fastify.log.info(`Server successfully bound to port ${PORT}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// ==========================================
// --- EXECUTION BOOTSTRAP ---
// ==========================================

bootstrapServer(fastify, redisClient, PORT, connectDB, initScheduler, startServer);
