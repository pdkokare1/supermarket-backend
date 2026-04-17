/* plugins/securitySetup.js */
'use strict';

module.exports = function(fastify) {
    
    // ENTERPRISE SECURITY FIX: Bulletproof Origin Resolution Function
    // This explicitly checks the incoming request against your Railway environment variables safely.
    fastify.register(require('@fastify/cors'), { 
        origin: function (origin, cb) {
            // 1. Allow internal server requests and mobile app fetches (no origin)
            if (!origin) return cb(null, true);

            // 2. Exact match against allowed environment strings (Your Railway VIP list)
            if (process.env.ALLOWED_ORIGINS) {
                const allowedList = process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
                if (allowedList.includes(origin)) {
                    return cb(null, true);
                }
            }

            // 3. Fallback to Regex for dynamic Vercel branches and local development
            const regexes = [
                /^https?:\/\/localhost(:\d+)?$/,
                /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
                /^https?:\/\/.*\.vercel\.app$/,     
                /^https?:\/\/.*\.hostinger\.com$/
            ];

            for (let reg of regexes) {
                if (reg.test(origin)) {
                    return cb(null, true);
                }
            }

            // 4. Reject anything else to protect the database
            cb(new Error("Not allowed by CORS"), false);
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
