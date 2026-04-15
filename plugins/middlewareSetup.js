/* plugins/middlewareSetup.js */

const auditService = require('../services/auditService');
const crypto = require('crypto'); // OPTIMIZATION: Natively generate correlation IDs

module.exports = function(fastify) {
    
    // OPTIMIZATION: Cloud Observability & Correlation Tracing
    fastify.addHook('onRequest', async (request, reply) => {
        // Generate or forward tracing ID
        const correlationId = request.headers['x-correlation-id'] || crypto.randomUUID();
        request.correlationId = correlationId;
        
        // Attach to the logger context so it automatically appears in all pino logs
        request.log = request.log.child({ correlationId });
        
        // Return to client so frontend errors can be directly mapped to backend logs
        reply.header('x-correlation-id', correlationId);
    });

    // OPTIMIZATION: Non-Blocking Compliance Logging Hook
    // Flushes the audit batch asynchronously ONLY after the response is securely sent to the user
    fastify.addHook('onResponse', async (request, reply) => {
        await auditService.flushAuditBatch();
    });

    // EFFICIENCY: Convert comma-separated string to an array for production lookups.
    const allowedOrigins = process.env.ALLOWED_ORIGINS 
        ? process.env.ALLOWED_ORIGINS.split(',') 
        : true; 

    // --- CORS SETUP ---
    // DISABLED: To prevent conflicts. CORS is already correctly handled and registered 
    // dynamically inside plugins/securitySetup.js
    /*
    fastify.register(require('@fastify/cors'), { 
        origin: allowedOrigins,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'x-api-key', 'x-correlation-id'],
        optionsSuccessStatus: 204 
    });
    */

    // --- HELMET SETUP ---
    fastify.register(require('@fastify/helmet'), {
        crossOriginResourcePolicy: { policy: "cross-origin" },
        crossOriginOpenerPolicy: { policy: "unsafe-none" },
        contentSecurityPolicy: false 
    });

    fastify.register(require('@fastify/rate-limit'), {
        max: 100,
        timeWindow: '1 minute',
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
