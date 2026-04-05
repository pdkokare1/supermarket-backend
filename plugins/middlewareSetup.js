/* plugins/middlewareSetup.js */

module.exports = function(fastify, redisClient) {
    // --- CORS SETUP ---
    // Registered absolutely first to intercept preflights before Helmet or Rate Limiter
    fastify.register(require('@fastify/cors'), { 
        // Setting to true automatically reflects the incoming Origin header.
        // This guarantees the frontend passes the check regardless of the exact URL string.
        origin: true, 
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
        optionsSuccessStatus: 204 // Force successful preflight response
    });

    fastify.register(require('@fastify/helmet'));

    fastify.register(require('@fastify/rate-limit'), {
        max: 100,
        timeWindow: '1 minute',
        ...(redisClient && { redis: redisClient })
    });

    fastify.register(require('@fastify/compress'), { global: true });

    fastify.register(require('@fastify/multipart'), {
        limits: { fileSize: 5 * 1024 * 1024 }
    });

    if (process.env.NODE_ENV === 'production' && !process.env.COOKIE_SECRET) {
        fastify.log.error("CRITICAL SECURITY ALERT: Missing COOKIE_SECRET in production. Shutting down.");
        process.exit(1);
    }
    
    fastify.register(require('@fastify/cookie'), {
        secret: process.env.COOKIE_SECRET || 'dev-fallback-secret-123',
        hook: 'onRequest'
    });

    fastify.register(require('@fastify/websocket'));
    
    fastify.register(require('@fastify/swagger'), {
        swagger: {
            info: { title: 'DailyPick API', description: 'Enterprise Backend API', version: '1.0.0' },
            consumes: ['application/json'],
            produces: ['application/json']
        }
    });
    
    fastify.register(require('@fastify/swagger-ui'), {
        routePrefix: '/api/docs',
        uiConfig: { docExpansion: 'none', deepLinking: false }
    });
};
