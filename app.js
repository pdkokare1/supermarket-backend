/* app.js */
'use strict';

const Fastify = require('fastify');
const initRedis = require('./config/redis'); 
const cacheUtils = require('./utils/cacheUtils');

const createApp = () => {
    const fastify = Fastify({
        logger: process.env.NODE_ENV === 'production' ? { level: 'info' } : true,
        trustProxy: true 
    });

    const redisClient = initRedis();
    
    // OPTIMIZED: Sync the cache utility with the global Redis client to save connections.
    cacheUtils.setClient(redisClient);
    fastify.decorate('redis', redisClient);

    // --- Modularized Setups ---
    require('./plugins/securitySetup')(fastify); 
    require('./plugins/serverUtilsSetup')(fastify); 
    require('./plugins/apiDocsSetup')(fastify); 
    
    // NEW: Handles internal event logic (e.g., auto-broadcasting)
    require('./plugins/eventsSetup')(fastify);

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
