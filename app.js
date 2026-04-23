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
            stream: require('pino').destination({ sync: false, minLength: 4096 }),
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
        trustProxy: process.env.TRUST_PROXY_HOPS ? parseInt(process.env.TRUST_PROXY_HOPS, 10) : 1,
        disableRequestLogging: isProduction,
        ignoreTrailingSlash: true,
        bodyLimit: process.env.BODY_LIMIT || 1048576, 
        connectionTimeout: process.env.CONNECTION_TIMEOUT || 10000, 
        keepAliveTimeout: process.env.KEEP_ALIVE_TIMEOUT || 5000,
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

    if (redisClient) {
        redisClient.on('error', (err) => fastify.log.error(`Redis Client Error: ${err.message}`));
        redisClient.on('connect', () => fastify.log.info('Redis Client successfully connected'));
        redisClient.on('reconnecting', () => fastify.log.warn('Redis Client is reconnecting to the server'));
    }
    
    cacheUtils.setClient(redisClient);
    
    fastify.register(fp(async (instance) => {
        instance.decorate('redis', redisClient);
    }));

    // --- Modularized Setups ---
    const corePlugins = ['securitySetup', 'middlewareSetup', 'apiDocsSetup', 'eventsSetup', 'authSetup', 'wsSetup', 'loadSheddingSetup', 'errorHandler'];
    corePlugins.forEach(plugin => require(`./plugins/${plugin}`)(fastify));

    const coreRoutes = ['systemRoutes', 'index'];
    coreRoutes.forEach(route => fastify.register(require(`./routes/${route}`)));

    fastify.addHook('onClose', async (instance, done) => {
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
