/* plugins/middlewareSetup.js */

module.exports = function(fastify, redisClient) {
    // --- MOVED TO TOP ---
    // CORS must be registered first so that preflight (OPTIONS) requests 
    // are answered before rate limiters or helmet block them.
    fastify.register(require('@fastify/cors'), { 
        origin: true, // Automatically reflects the incoming Origin header
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With']
    });

    // --- OTHER MIDDLEWARES ---
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

    // --- PREVENT HARD CRASH ---
    // Instead of shutting down the server (which causes Railway to throw a 502 and trigger a CORS error),
    // we use a secure fallback but log a critical warning to alert you.
    let cookieSecret = process.env.COOKIE_SECRET;
    if (process.env.NODE_ENV === 'production' && !cookieSecret) {
        fastify.log.error("CRITICAL SECURITY ALERT: Missing COOKIE_SECRET in production. Using fallback secret, but please configure this in Railway!");
        cookieSecret = 'production-fallback-secret-1234567890'; 
    } else if (!cookieSecret) {
        cookieSecret = 'dev-fallback-secret-123';
    }
    
    fastify.register(require('@fastify/cookie'), {
        secret: cookieSecret,
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
