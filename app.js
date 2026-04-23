/* app.js */
'use strict';

const Fastify = require('fastify');
const fp = require('fastify-plugin'); 
const initRedis = require('./config/redis'); 
const cacheUtils = require('./utils/cacheUtils');
const mongoose = require('mongoose'); 

const createApp = (opts = {}) => {
    const isProduction = process.env.NODE_ENV === 'production';
    
    const fastify = Fastify({
        logger: isProduction ? { 
            level: 'info',
            // OPTIMIZATION: Redact sensitive credential headers to prevent them from hitting cloud log streams
            redact: ['req.headers.authorization', 'req.headers.cookie'] 
        } : {
            transport: {
                target: 'pino-pretty',
                options: {
                    translateTime: 'HH:MM:ss Z',
                    ignore: 'pid,hostname'
                }
            }
        },
        // ENTERPRISE SECURITY FIX: Restrict proxy trust to immediate upstream load balancers (Railway/Vercel) to prevent IP spoofing
        trustProxy: process.env.TRUST_PROXY_HOPS ? parseInt(process.env.TRUST_PROXY_HOPS, 10) : 1,
        
        // OPTIMIZATION: Disables automatic logging of every single HTTP request to save heavy disk I/O in production.
        disableRequestLogging: isProduction,
        // OPTIMIZATION: Normalizes routes to prevent 404s on trailing slashes and speeds up radix tree routing.
        ignoreTrailingSlash: true,
        
        // ENTERPRISE SECURITY: Dynamic payload and slowloris limits via env variables for zero-code deployments.
        bodyLimit: process.env.BODY_LIMIT || 1048576, // 1MB fallback
        connectionTimeout: process.env.CONNECTION_TIMEOUT || 10000, 
        keepAliveTimeout: process.env.KEEP_ALIVE_TIMEOUT || 5000,
        
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
        maxEventLoopDelay: process.env.MAX_EVENT_LOOP_DELAY || 1000,
        maxHeapUsedBytes: process.env.MAX_HEAP_BYTES || 1000000000, // 1GB
        maxRssBytes: process.env.MAX_RSS_BYTES || 1000000000,
        maxEventLoopUtilization: process.env.MAX_EVENT_LOOP_UTIL || 0.98,
        message: 'Service Unavailable: DailyPick server is under heavy load. Please try again later.',
        retryAfter: process.env.RETRY_AFTER || 50
    });

    // --- Modularized Setups ---
    const corePlugins = ['securitySetup', 'middlewareSetup', 'apiDocsSetup', 'eventsSetup', 'authSetup', 'wsSetup', 'errorHandler'];
    corePlugins.forEach(plugin => require(`./plugins/${plugin}`)(fastify));

    const coreRoutes = ['systemRoutes', 'index'];
    coreRoutes.forEach(route => fastify.register(require(`./routes/${route}`)));

    // OPTIMIZATION: Graceful Shutdown Hook with Promise.race fallback timeout
    fastify.addHook('onClose', async (instance, done) => {
        // Fastify.close() guarantees active traffic is drained before this log executes
        instance.log.info('Active requests drained. Server shutting down. Closing database connections...');
        
        const closeConnections = async () => {
            if (mongoose.connection.readyState === 1) await mongoose.connection.close();
            if (redisClient) await redisClient.quit();
        };

        const shutdownLimit = process.env.SHUTDOWN_TIMEOUT || 5000;
        const timeout = new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Shutdown operation timed out after ${shutdownLimit}ms`)), shutdownLimit)
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
