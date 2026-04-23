/* utils/processManager.js */
'use strict';

const mongoose = require('mongoose');

const setupProcessManager = (fastify) => {
    process.on('unhandledRejection', (err) => {
        fastify.log.error(`UNHANDLED REJECTION: ${err.message}`);
        if (fastify.log.flushSync) {
            fastify.log.flushSync();
        }
        process.exit(1);
    });

    process.on('uncaughtException', (err) => {
        fastify.log.error(`UNCAUGHT EXCEPTION: ${err.message}`);
        if (fastify.log.flushSync) {
            fastify.log.flushSync();
        }
        process.exit(1);
    });

    let isShuttingDown = false; 
    const shutdownSignalHandler = async (signal) => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        fastify.log.info(`Worker ${process.pid} received ${signal}. Stopping new traffic and completing active checkouts...`);
        
        const killTimer = setTimeout(() => {
            fastify.log.error('Graceful shutdown drain timeout exceeded. Forcing process exit.');
            if (fastify.log.flushSync) fastify.log.flushSync();
            process.exit(1);
        }, 10000);

        try {
            await fastify.close(); 
            
            // OPTIMIZATION: Safely drain and sever persistent database connections to prevent mid-transaction corruption
            if (mongoose.connection.readyState === 1) {
                await mongoose.connection.close(false);
                fastify.log.info('MongoDB connections closed safely.');
            }
            if (fastify.redis) {
                await fastify.redis.quit();
                fastify.log.info('Redis connections closed safely.');
            }

            clearTimeout(killTimer); 
            process.exit(0);
        } catch (err) {
            clearTimeout(killTimer);
            fastify.log.error(`Error during graceful shutdown: ${err.message}`);
            process.exit(1);
        }
    };

    process.on('SIGINT', () => shutdownSignalHandler('SIGINT'));
    process.on('SIGTERM', () => shutdownSignalHandler('SIGTERM'));
};

module.exports = setupProcessManager;
