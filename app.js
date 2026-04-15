/* app.js */
'use strict';

const Fastify = require('fastify');
const fp = require('fastify-plugin'); 
const initRedis = require('./config/redis'); 
const cacheUtils = require('./utils/cacheUtils');
const mongoose = require('mongoose'); 

const createApp = (opts = {}) => {
    const fastify = Fastify({
        logger: process.env.NODE_ENV === 'production' ? { level: 'info' } : {
            transport: {
                target: 'pino-pretty',
                options: {
                    translateTime: 'HH:MM:ss Z',
                    ignore: 'pid,hostname'
                }
            }
        },
        trustProxy: true,
        // ENTERPRISE SECURITY: Prevent payload memory exhaustion and slowloris attacks
        bodyLimit: 1048576, // 1MB payload limit
        connectionTimeout: 10000, 
        keepAliveTimeout: 5000,
        // OPTIMIZATION: Enterprise validation to strip malicious or unknown payload data automatically
        ajv: {
            customOptions: {
                removeAdditional: 'all',
                coerceTypes: true,
                useDefaults: true
            }
        },
        ...opts
    });

    const redisClient = initRedis();

    // OPTIMIZATION: Enterprise Redis lifecycle monitoring to prevent silent cache failures
    if (redisClient) {
        redisClient.on('error', (err) => fastify.log.error(`Redis Client Error: ${err.message}`));
        redisClient.on('connect', () => fastify.log.info('Redis Client successfully connected'));
        redisClient.on('reconnecting', () => fastify.log.warn('Redis Client is reconnecting to the server'));
    }
    
    // SYNC: Use the same Redis client for caching to save memory.
    cacheUtils.setClient(redisClient);
    
    // OPTIMIZATION: Wrapped decorator in fastify-plugin to ensure global scope across all encapsulated routes/plugins
    fastify.register(fp(async (instance) => {
        instance.decorate('redis', redisClient);
    }));

    // ENTERPRISE STABILITY: Load Shedding. Prevents Event Loop collapse under DDoS/heavy traffic.
    fastify.register(require('@fastify/under-pressure'), {
        maxEventLoopDelay: 1000,
        maxHeapUsedBytes: 1000000000, // 1GB
        maxRssBytes: 1000000000,
        maxEventLoopUtilization: 0.98,
        message: 'Service Unavailable: DailyPick server is under heavy load. Please try again later.',
        retryAfter: 50
    });

    // --- Modularized Setups ---
    require('./plugins/securitySetup')(fastify); 
    require('./plugins/serverUtilsSetup')(fastify); 
    require('./plugins/apiDocsSetup')(fastify); 
    require('./plugins/eventsSetup')(fastify);
    require('./plugins/authSetup')(fastify);
    require('./plugins/wsSetup')(fastify);
    require('./plugins/errorHandler')(fastify);

    fastify.register(require('./routes/systemRoutes'));
    fastify.register(require('./routes')); 

    // OPTIMIZATION: Graceful Shutdown Hook with Promise.race fallback timeout
    fastify.addHook('onClose', async (instance, done) => {
        // Fastify.close() guarantees active traffic is drained before this log executes
        instance.log.info('Active requests drained. Server shutting down. Closing database connections...');
        
        const closeConnections = async () => {
            if (mongoose.connection.readyState === 1) await mongoose.connection.close();
            if (redisClient) await redisClient.quit();
        };

        const timeout = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Shutdown operation timed out after 5000ms')), 5000)
        );

        try {
            await Promise.race([closeConnections(), timeout]);
            instance.log.info('Connections closed successfully.');
        } catch (err) {
            instance.log.error('Error during shutdown:', err);
        }
        
        done();
    });

    return { fastify, redisClient };
};

module.exports = createApp;
