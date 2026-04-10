/* app.js */
'use strict';

const Fastify = require('fastify');
const initRedis = require('./config/redis'); 

/**
 * APPLICATION FACTORY
 * This file strictly configures the Fastify instance and its plugins.
 * It does not start the server or handle clustering.
 */
const createApp = () => {
    const fastify = Fastify({
        logger: process.env.NODE_ENV === 'production' ? { level: 'info' } : true,
        trustProxy: true 
    });

    const redisClient = initRedis();
    
    // Decorate Fastify with the Redis client for global access.
    fastify.decorate('redis', redisClient);

    // --- Modularized Setups ---
    require('./plugins/middlewareSetup')(fastify); 
    require('./plugins/authSetup')(fastify);
    require('./plugins/wsSetup')(fastify);
    require('./plugins/errorHandler')(fastify);

    // --- Modularized System Routes ---
    fastify.register(require('./routes/systemRoutes'));

    // --- Feature Routes ---
    fastify.register(require('./routes')); 

    return { fastify, redisClient };
};

module.exports = createApp;
