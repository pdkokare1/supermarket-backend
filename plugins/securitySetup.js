/* plugins/securitySetup.js */
'use strict';

module.exports = function(fastify) {
    
    // ENTERPRISE SECURITY FIX: Strict Origin Whitelisting
    // Replacing the insecure 'origin: true' Universal Reflector with strict validation.
    // Ensure you set ALLOWED_ORIGINS in your Railway Environment Variables (e.g., "https://mydomain.com,https://admin.mydomain.com")
    const allowedOrigins = process.env.ALLOWED_ORIGINS 
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
        : [/^https?:\/\/localhost:\d+$/]; // Fallback to local dev if not set

    fastify.register(require('@fastify/cors'), { 
        origin: allowedOrigins,
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
                frameAncestors: ["'none'"], // Prevent clickjacking
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
        hook: 'preHandler', // ENTERPRISE FIX: Allow auth middleware to run first
        // ENTERPRISE FIX: Prioritize Authenticated User ID to prevent false-positive NAT IP bans
        keyGenerator: function (request) {
            if (request.user && request.user.id) {
                return request.user.id;
            }
            return request.ip;
        },
        errorResponseBuilder: function (request, context) {
            return {
                statusCode: 429,
                error: 'Too Many Requests',
                message: `Rate limit exceeded. Try again in ${context.after}.`
            };
        },
        redis: fastify.redis || null,
        skipFailedRequests: true, // OPTIMIZATION: Bypasses rate-limiting gracefully if the Redis connection drops, keeping the API online.
        continueExceeding: true
    });
};
