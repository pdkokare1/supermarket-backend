/* server.js */
'use strict';

const mongoose = require('mongoose');
const cluster = require('cluster');
const os = require('os');
require('dotenv').config();

const connectDB = require('./config/db');
const { handleInventoryReport } = require('./jobs/inventoryHandler'); 
const { bootstrapServer } = require('./utils/serverProcessUtils');
const createApp = require('./app');

// ==========================================
// --- ENTERPRISE CLUSTER ORCHESTRATION ---
// ==========================================

const numCPUs = os.cpus().length;

if (cluster.isMaster) {
    console.log(`Primary cluster process ${process.pid} is running`);

    // Fork workers for each CPU core
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    // Replace dead workers automatically to maintain high availability
    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died with code: ${code}, and signal: ${signal}`);
        console.log('Starting a new worker...');
        cluster.fork();
    });

    // Graceful shutdown for the entire cluster
    const shutdownCluster = (signal) => {
        console.log(`Primary received ${signal}. Shutting down all workers...`);
        for (const id in cluster.workers) {
            cluster.workers[id].process.kill(signal);
        }
    };

    process.on('SIGINT', () => shutdownCluster('SIGINT'));
    process.on('SIGTERM', () => shutdownCluster('SIGTERM'));

} else {
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

    // OPTIMIZATION: Catch container termination signals (Railway/Vercel) to trigger graceful server drain.
    const shutdownSignalHandler = async (signal) => {
        fastify.log.info(`Worker ${process.pid} received ${signal}. Stopping new traffic and completing active checkouts...`);
        
        // Failsafe: Prevent container orchestration platforms from executing a hard unlogged kill.
        setTimeout(() => {
            fastify.log.error('Graceful shutdown drain timeout exceeded. Forcing process exit.');
            if (fastify.log.flushSync) fastify.log.flushSync();
            process.exit(1);
        }, 10000).unref();

        try {
            await fastify.close(); // Triggers the onClose hook in app.js natively after draining
            process.exit(0);
        } catch (err) {
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
            fastify.log.info(`Worker ${process.pid} successfully bound to port ${PORT}`);
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
