/* plugins/middlewareSetup.js */

module.exports = function(fastify, redisClient) {
    fastify.register(require('@fastify/helmet'));

    const rateLimitConfig = {
        max: 100,
        timeWindow: '1 minute'
    };
    if (redisClient) {
        rateLimitConfig.redis = redisClient; 
    }
    fastify.register(require('@fastify/rate-limit'), rateLimitConfig);

    const dynamicOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
    const allowedOrigins = [
        'http://localhost:3000',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        process.env.FRONTEND_URL,
        ...dynamicOrigins
    ].filter(Boolean);

    fastify.register(require('@fastify/cors'), { 
        origin: allowedOrigins, 
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With']
    });

    fastify.register(require('@fastify/compress'), { global: true });

    fastify.register(require('@fastify/multipart'), {
        limits: {
            fileSize: 5 * 1024 * 1024 
        }
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
