/* server.js */
'use strict';

const cluster = require('cluster');
const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = require('./config/db');
const { handleInventoryReport } = require('./jobs/inventoryHandler'); 
const { setupGracefulShutdown, setupCluster } = require('./utils/serverProcessUtils');
const createApp = require('./app');

// Initialize the Application Configuration
const { fastify, redisClient } = createApp();
const PORT = process.env.PORT || 3000;

// ==========================================
// --- INITIALIZATION HELPERS ---
// ==========================================

const initScheduler = () => {
    require('./jobs/cronScheduler')(fastify, (newReport) => 
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

// Setup Process-Level Utilities
setupGracefulShutdown(fastify, redisClient);

if (process.env.ENABLE_CLUSTERING === 'true' && cluster.isPrimary) {
    // Primary Cluster Process
    setupCluster(fastify, connectDB, initScheduler);
} else if (process.env.ENABLE_CLUSTERING !== 'true') {
    // Standalone Mode (Development or Small Environments)
    initScheduler();
    startServer(); 
} else {
    // Worker Processes (Traffic Handlers)
    startServer(); 
}
