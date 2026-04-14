/* utils/serverProcessUtils.js */

const mongoose = require('mongoose');
const cluster = require('cluster');
const os = require('os');
const v8 = require('v8');

process.on('uncaughtException', (err) => {
    console.error('[PROCESS] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[PROCESS] Unhandled Rejection at:', promise, 'reason:', reason);
});

// OPTIMIZATION: Self-Healing Memory Tripwire
// Prevents harsh OS kills by gracefully draining traffic if Heap gets dangerously full.
const startMemoryWatchdog = (fastify) => {
    setInterval(() => {
        const stats = v8.getHeapStatistics();
        const usageRatio = stats.used_heap_size / stats.heap_size_limit;
        
        if (usageRatio > 0.85 && !fastify.isShuttingDown) {
            fastify.log.fatal(`[OOM WARNING] Heap usage at ${(usageRatio * 100).toFixed(2)}%. Triggering self-healing shutdown to protect transactions.`);
            process.emit('SIGTERM'); 
        }
    }, 10000).unref(); 
};

exports.setupGracefulShutdown = (fastify, redisClient) => {
    const listeners = ['SIGINT', 'SIGTERM'];
    listeners.forEach((signal) => {
        process.on(signal, async () => {
            if (fastify.isShuttingDown) return; // Prevent double-triggering
            
            fastify.log.info(`${signal} received. Shutting down gracefully...`);
            fastify.isShuttingDown = true; 

            if (typeof fastify.closeAllSSE === 'function') fastify.closeAllSSE();
            
            setTimeout(() => {
                fastify.log.error('Forcing shutdown after timeout. Some active processes may have been terminated.');
                process.exit(1);
            }, 15000).unref(); 

            try {
                if (fastify.server && fastify.server.closeIdleConnections) {
                    fastify.server.closeIdleConnections();
                }

                await fastify.close();
                await mongoose.connection.close();
                if (redisClient) await redisClient.quit();
                if (typeof fastify.closeRedisWS === 'function') await fastify.closeRedisWS(); 
                
                fastify.log.info('Clean shutdown complete.');
                process.exit(0);
            } catch (err) {
                fastify.log.error('Error during shutdown:', err);
                process.exit(1);
            }
        });
    });
};

exports.setupCluster = (fastify, connectDB, initScheduler) => {
    connectDB(fastify).then(() => {
        initScheduler();
        
        const numWorkers = process.env.MAX_WORKERS ? parseInt(process.env.MAX_WORKERS, 10) : Math.min(os.cpus().length, 4);
        console.log(`[CLUSTER] Primary Process ${process.pid} running. Distributing traffic across ${numWorkers} workers...`);
        
        for (let i = 0; i < numWorkers; i++) cluster.fork(); 

        cluster.on('exit', (worker, code, signal) => {
            console.log(`[CLUSTER] Worker ${worker.process.pid} died or crashed. Auto-restarting...`);
            cluster.fork(); 
        });
    });
};

exports.bootstrapServer = async (fastify, redisClient, port, connectDB, initScheduler, startServer) => {
    this.setupGracefulShutdown(fastify, redisClient);
    startMemoryWatchdog(fastify);

    if (process.env.ENABLE_CLUSTERING === 'true' && cluster.isPrimary) {
        this.setupCluster(fastify, connectDB, initScheduler);
    } else {
        startServer();
    }
};
