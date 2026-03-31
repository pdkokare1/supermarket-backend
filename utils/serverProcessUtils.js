/* utils/serverProcessUtils.js */

const mongoose = require('mongoose');
const cluster = require('cluster');
const os = require('os');

exports.setupGracefulShutdown = (fastify, redisClient) => {
    const listeners = ['SIGINT', 'SIGTERM'];
    listeners.forEach((signal) => {
        process.on(signal, async () => {
            fastify.log.info(`${signal} received. Shutting down gracefully...`);
            
            if (typeof fastify.closeAllSSE === 'function') fastify.closeAllSSE();
            
            setTimeout(() => {
                fastify.log.error('Forcing shutdown after timeout. Some active processes may have been terminated.');
                process.exit(1);
            }, 15000).unref(); 

            try {
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
        const numCPUs = os.cpus().length;
        console.log(`[CLUSTER] Primary Process ${process.pid} running. Distributing traffic across ${numCPUs} CPUs...`);
        
        for (let i = 0; i < numCPUs; i++) cluster.fork(); 

        cluster.on('exit', (worker, code, signal) => {
            console.log(`[CLUSTER] Worker ${worker.process.pid} died or crashed. Auto-restarting...`);
            cluster.fork(); 
        });
    });
};
