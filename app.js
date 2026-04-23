/* app.js */
'use strict';

const Fastify = require('fastify');
const fp = require('fastify-plugin'); 
const initRedis = require('./config/redis'); 
const cacheUtils = require('./utils/cacheUtils');
const mongoose = require('mongoose'); 
const crypto = require('crypto');

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
        // OPTIMIZATION: Native Correlation Tracing integration avoids GC-heavy .child() logger instantiation per request
        genReqId: function (req) {
            return req.headers['x-correlation-id'] || crypto.randomUUID();
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

    return { fastify, redisClient };
};

module.exports = createApp;
