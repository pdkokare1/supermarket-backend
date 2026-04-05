/* plugins/middlewareSetup.js */

module.exports = function(fastify, redisClient) {
    // --- MOVED TO TOP ---
    // CORS must be registered first so that preflight (OPTIONS) requests 
    // are answered before rate limiters or helmet block them.
    const allowedOrigins = [
        'http://localhost:3000',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'https://dailypick-admin.vercel.app',
        process.env.FRONTEND_URL,
        ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [])
    ].filter(Boolean).map(url => url.replace(/\/$/, '')); // Strip trailing slashes

    fastify.register(require('@fastify/cors'), { 
        // Dynamic origin function replaces the static array
        origin: (origin, cb) => {
            // Allow requests with no origin (e.g., server-to-server or local scripts)
            if (!origin) return cb(null, true);
            
            // Clean the incoming origin to ensure strict matching works
            const requestOrigin = origin.replace(/\/$/, '');
            
            if (allowedOrigins.includes(requestOrigin)) {
                cb(null, true);
            } else {
                cb(null, false);
            }
        },
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
