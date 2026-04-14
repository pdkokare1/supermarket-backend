/* app.js */
'use strict';

const Fastify = require('fastify');
const fp = require('fastify-plugin'); 
const initRedis = require('./config/redis'); 
const cacheUtils = require('./utils/cacheUtils');
const mongoose = require('mongoose'); 

const createApp = (opts = {}) => {
    const fastify = Fastify({
        logger: process.env.NODE_ENV === 'production' ? { level: 'info' } : true,
        trustProxy: true,
        ...opts
    });

    const redisClient = initRedis();
    
    // SYNC: Use the same Redis client for caching to save memory.
    cacheUtils.setClient(redisClient);
    
    // OPTIMIZATION: Wrapped decorator in fastify-plugin to ensure global scope across all encapsulated routes/plugins
    fastify.register(fp(async (instance) => {
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
