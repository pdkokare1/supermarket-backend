/* plugins/securitySetup.js */
'use strict';

module.exports = function(fastify) {
    
    // ENTERPRISE SECURITY FIX: Strict Regex boundaries prevent DNS spoofing bypasses.
    // The '^' ensures it starts with http/https, and '$' ensures exact suffix matching.
    const allowedOriginsRegex = [
        /^https?:\/\/localhost(:\d+)?$/,
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
        /^https?:\/\/.*\.vercel\.app$/,     
        /^https?:\/\/.*\.hostinger\.com$/    // Adjusted for Hostinger TLD
    ];

    if (process.env.ALLOWED_ORIGINS) {
        const envOrigins = process.env.ALLOWED_ORIGINS.split(',');
        envOrigins.forEach(o => {
            const cleanOrigin = o.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Ensure dynamic env origins are strictly bound to prevent partial matching
            allowedOriginsRegex.push(new RegExp(`^${cleanOrigin}$`));
        });
    }

    fastify.register(require('@fastify/cors'), { 
        origin: allowedOriginsRegex,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'x-api-key', 'Idempotency-Key'],
        optionsSuccessStatus: 204,
        // PERFORMANCE: Cache CORS preflight responses for 24 hours to halve OPTIONS request spam
        maxAge: 86400 
    });

    fastify.register(require('@fastify/helmet'), {
        crossOriginResourcePolicy: { policy: "cross-origin" },
        crossOriginOpenerPolicy: { policy: "unsafe-none" },
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                objectSrc: ["'none'"],
                upgradeInsecureRequests: [],
            },
        },
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
        // ENTERPRISE SECURITY: Conceal your underlying technology stack from automated scanners
        hidePoweredBy: true
    });

    fastify.register(require('@fastify/rate-limit'), {
        max: 100,
        timeWindow: '1 minute',
        // ENTERPRISE SECURITY: Progressive Edge Banning. 
        // Blocks IPs completely if they violate the rate limit 3 consecutive times.
        ban: 3, 
        keyGenerator: function (request) {
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
        continueExceeding: true
    });
};
