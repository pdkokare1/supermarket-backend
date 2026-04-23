/* server.js */
'use strict';

// OPTIMIZATION: Load environment variables absolutely first so all subsequent modules have access.
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const cluster = require('cluster');
const os = require('os');
const connectDB = require('./config/db');
const { handleInventoryReport } = require('./jobs/inventoryHandler'); 
const { bootstrapServer } = require('./utils/serverProcessUtils');
const setupProcessManager = require('./utils/processManager');
const createApp = require('./app');

// ==========================================
// --- CLUSTER MANAGER (MASTER PROCESS) ---
// ==========================================

if (cluster.isPrimary) {
    const numCPUs = process.env.WEB_CONCURRENCY ? parseInt(process.env.WEB_CONCURRENCY, 10) : os.cpus().length;
    
    console.log(`[MASTER] DailyPick Cluster Primary ${process.pid} is running`);
    console.log(`[MASTER] Forking ${numCPUs} worker processes...`);

    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.error(`[MASTER] Worker ${worker.process.pid} died (Code: ${code}, Signal: ${signal}). Starting a new worker...`);
        cluster.fork();
    });

} else {
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
        require('./jobs/backupCron')(fastify); 
        
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
}
