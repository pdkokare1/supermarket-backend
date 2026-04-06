/* plugins/middlewareSetup.js */

// OPTIMIZED: Removed redisClient parameter. Relying on global fastify.redis.
module.exports = function(fastify) {
    // --- CORS SETUP ---
    fastify.register(require('@fastify/cors'), { 
        // Forcefully approve all origins via callback to bypass strict validation
        origin: function (origin, cb) {
            cb(null, true);
        },
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
        optionsSuccessStatus: 204 
    });

    // --- HELMET SETUP ---
    // We must explicitly tell Helmet to allow cross-origin resource sharing,
    // otherwise it silently overrides our CORS setup and blocks API reads.
    fastify.register(require('@fastify/helmet'), {
        crossOriginResourcePolicy: { policy: "cross-origin" },
        crossOriginOpenerPolicy: { policy: "unsafe-none" },
        contentSecurityPolicy: false // Disable CSP for API to prevent Vercel blockages
    });

    fastify.register(require('@fastify/rate-limit'), {
        max: 100,
        timeWindow: '1 minute',
        // OPTIMIZED: Grabbing Redis directly from the Fastify instance
        ...(fastify.redis && { redis: fastify.redis })
    });

    fastify.register(require('@fastify/compress'), { global: true });

    fastify.register(require('@fastify/multipart'), {
        limits: { fileSize: 5 * 1024 * 1024 }
    });

    let cookieSecret = process.env.COOKIE_SECRET;
    if (process.env.NODE_ENV === 'production' && !cookieSecret) {
        fastify.log.warn("CRITICAL SECURITY ALERT: Missing COOKIE_SECRET in production. Using fallback secret, but please configure this in Railway!");
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
