/* plugins/securitySetup.js */
'use strict';

module.exports = function(fastify) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS 
        ? process.env.ALLOWED_ORIGINS.split(',') 
        : true; 

    // --- CORS SETUP ---
    fastify.register(require('@fastify/cors'), { 
        origin: allowedOrigins,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
        optionsSuccessStatus: 204 
    });

    // --- HELMET SETUP ---
    fastify.register(require('@fastify/helmet'), {
        crossOriginResourcePolicy: { policy: "cross-origin" },
        crossOriginOpenerPolicy: { policy: "unsafe-none" },
        contentSecurityPolicy: false 
    });

    // --- RATE LIMIT SETUP ---
    fastify.register(require('@fastify/rate-limit'), {
        max: 100,
        timeWindow: '1 minute',
        ...(fastify.redis && { redis: fastify.redis })
    });
};
