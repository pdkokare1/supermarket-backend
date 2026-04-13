/* app.js */
'use strict';

const Fastify = require('fastify');
const fp = require('fastify-plugin'); // OPTIMIZATION: Added for proper plugin encapsulation
const initRedis = require('./config/redis'); 
const cacheUtils = require('./utils/cacheUtils');
const mongoose = require('mongoose'); // OPTIMIZATION: Needed for graceful database shutdown

const createApp = () => {
    const fastify = Fastify({
        logger: process.env.NODE_ENV === 'production' ? { level: 'info' } : true,
        trustProxy: true 
    });

    const redisClient = initRedis();
    
    // SYNC: Use the same Redis client for caching to save memory.
    cacheUtils.setClient(redisClient);
    
    // OPTIMIZATION: Wrapped decorator in fastify-plugin to ensure global scope across all encapsulated routes/plugins
    fastify.register(fp(async (instance, opts) => {
        instance.decorate('redis', redisClient);
    }));

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

    // OPTIMIZATION: Graceful Shutdown Hook to prevent zombie DB connections during Railway/Vercel redeployments
    fastify.addHook('onClose', async (instance, done) => {
        instance.log.info('Server shutting down. Closing database connections...');
        try {
            if (mongoose.connection.readyState === 1) {
                await mongoose.connection.close();
            }
            if (redisClient) {
                await redisClient.quit();
            }
        } catch (err) {
            instance.log.error('Error during shutdown:', err);
        }
        done();
    });

    return { fastify, redisClient };
};

module.exports = createApp;
