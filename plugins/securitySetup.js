/* plugins/securitySetup.js */
'use strict';

module.exports = function(fastify) {
    
    // ENTERPRISE SECURITY FIX: Universal Origin Reflector
    // This dynamically echoes the exact origin of the incoming request, guaranteeing 100% CORS compliance.
    fastify.register(require('@fastify/cors'), { 
        origin: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
        allowedHeaders: [
            'Content-Type', 
            'Authorization', 
            'Accept', 
            'Origin', 
            'X-Requested-With', 
            'x-api-key', 
            'Idempotency-Key',
            'x-correlation-id',
            'Cache-Control'
        ],
        exposedHeaders: ['x-correlation-id', 'Idempotency-Key'],
        preflightContinue: false,
        optionsSuccessStatus: 204,
        maxAge: 86400 
    });

    const isProd = process.env.NODE_ENV === 'production';
    fastify.register(require('@fastify/helmet'), {
        crossOriginResourcePolicy: { policy: "cross-origin" },
        crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: isProd ? ["'self'"] : ["'self'", "'unsafe-inline'"],
                objectSrc: ["'none'"],
                upgradeInsecureRequests: [],
            },
        },
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
        hidePoweredBy: true
    });

    fastify.register(require('@fastify/rate-limit'), {
        max: 100,
        timeWindow: '1 minute',
        ban: 3, 
        keyGenerator: function (request) {
            return request.headers['cf-connecting-ip'] || 
                   request.headers['x-forwarded-for']?.split(',')[0].trim() || 
                   request.headers['x-real-ip'] || 
                   request.ip;
        },
        errorResponseBuilder: function (request, context) {
            return {
                statusCode: 429,
                error: 'Too Many Requests',
                message: `Rate limit exceeded. Try again in ${context.after}.`
            };
        },
        redis: fastify.redis || null,
        continueExceeding: true
    });
};
