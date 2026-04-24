/* plugins/securitySetup.js */
'use strict';

const threatDefenseService = require('../services/threatDefenseService');

module.exports = function(fastify) {
    
    // OPTIMIZATION: Parse origins once at startup into an O(1) lookup Set.
    // Effect: Reduces CORS validation time complexity from O(N) to O(1) per request.
    const allowedOriginsSet = new Set(
        process.env.ALLOWED_ORIGINS 
            ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim().replace(/\/$/, ''))
            : []
    );
    const isLocalDev = /^https?:\/\/localhost:\d+$/;

    fastify.register(require('@fastify/cors'), { 
        // ENTERPRISE FIX: Custom origin function for maximum O(1) performance
        origin: (origin, cb) => {
            if (!origin || allowedOriginsSet.has(origin)) {
                cb(null, true);
                return;
            }
            if (process.env.NODE_ENV !== 'production' && isLocalDev.test(origin)) {
                cb(null, true);
                return;
            }
            cb(new Error('Origin not allowed by CORS'), false);
        },
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
                frameAncestors: ["'none'"], 
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
        hook: 'preHandler', 
        keyGenerator: function (request) {
            // OPTIMIZATION: Faster truthy evaluation without nested branching
            return (request.user && request.user.id) ? request.user.id : request.ip;
        },
        errorResponseBuilder: function (request, context) {
            return {
                statusCode: 429,
                error: 'Too Many Requests',
                message: `Rate limit exceeded. Try again in ${context.after}.`
            };
        },
        redis: fastify.redis || null,
        skipFailedRequests: true, 
        continueExceeding: true
    });

    // OPTIMIZATION: Unified Radix Tree Routing for Honeypots
    // Effect: Replaces multiple distinct route registrations with a single optimized regex constraint.
    // Prevents the router tree from fragmenting at the root level, speeding up standard API routes.
    fastify.all('/:trap(^\\.env|wp-admin|wp-login\\.php|config\\.json)', async (request, reply) => {
        await threatDefenseService.triggerHoneypot(request.ip);
        return reply.status(403).send({ success: false, message: 'Forbidden' });
    });
};
