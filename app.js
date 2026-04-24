/* app.js */
'use strict';

const path = require('path');
const Fastify = require('fastify');
const fp = require('fastify-plugin'); 
const initRedis = require('./config/redis'); 
const cacheUtils = require('./utils/cacheUtils');
const mongoose = require('mongoose'); 
const loggerConfig = require('./config/logger');

const createApp = (opts = {}) => {
    const isProduction = process.env.NODE_ENV === 'production';
    
    const fastify = Fastify({
        logger: loggerConfig,
        // OPTIMIZATION: Native Header Integration. Fastify's C-level hyperid handles this significantly faster than custom JS functions.
        requestIdHeader: 'x-correlation-id',
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

    // Pass the fastify logger directly to the redis initializer
    const redisClient = initRedis(fastify.log);
    
    cacheUtils.setClient(redisClient);
    
    fastify.register(fp(async (instance) => {
        instance.decorate('redis', redisClient);
    }));

    // --- Modularized Setups ---
    
    // Retained manual execution for plugins to guarantee global scope without risking Fastify encapsulation issues.
    const corePlugins = ['securitySetup', 'middlewareSetup', 'apiDocsSetup', 'eventsSetup', 'authSetup', 'wsSetup', 'loadSheddingSetup', 'errorHandler'];
    corePlugins.forEach(plugin => require(`./plugins/${plugin}`)(fastify));

    // OPTIMIZATION: Enterprise Auto-loading for Routes. 
    // Replaces manual array mapping. Fastify now handles asynchronous loading natively.
    fastify.register(require('@fastify/autoload'), {
        dir: path.join(__dirname, 'routes')
    });

    return { fastify, redisClient };
};

module.exports = createApp;
