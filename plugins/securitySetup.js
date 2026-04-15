/* plugins/securitySetup.js */
'use strict';

module.exports = function(fastify) {
    
    // OPTIMIZATION: Bulletproof Regex Array for native Fastify CORS resolution
    // This allows Fastify to immediately send Access-Control-Allow-Origin without async callback overhead
    const allowedOriginsRegex = [
        /localhost/,
        /127\.0\.0\.1/,
        /vercel\.app/,    // Matches any Vercel domain dynamically
        /hostinger/       // Matches custom Hostinger setups
    ];

    // Read static origins from ENV if they exist
    if (process.env.ALLOWED_ORIGINS) {
        const envOrigins = process.env.ALLOWED_ORIGINS.split(',');
        envOrigins.forEach(o => {
            // Push static strings dynamically mapped from your environment variables
            allowedOriginsRegex.push(new RegExp(o.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        });
    }

    fastify.register(require('@fastify/cors'), { 
        origin: allowedOriginsRegex,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'x-api-key', 'Idempotency-Key'],
        optionsSuccessStatus: 204 
    });

    fastify.register(require('@fastify/helmet'), {
        crossOriginResourcePolicy: { policy: "cross-origin" },
        crossOriginOpenerPolicy: { policy: "unsafe-none" },
        // ENTERPRISE COMPLIANCE: Strict CSP and HSTS injected
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                objectSrc: ["'none'"],
                upgradeInsecureRequests: [],
            },
        },
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
    });

    fastify.register(require('@fastify/rate-limit'), {
        max: 100,
        timeWindow: '1 minute',
        // OPTIMIZATION: DDOS Protection - Correctly resolve IPs behind load balancers
        keyGenerator: function (request) {
            // Because trustProxy is true in app.js, Fastify safely parses the correct client IP.
            return request.ip;
        },
        // Global error message customization for rate limits
        errorResponseBuilder: function (request, context) {
            return {
                statusCode: 429,
                error: 'Too Many Requests',
                message: `Rate limit exceeded. Try again in ${context.after}.`
            };
        },
        // OPTIMIZATION: Explicitly link global Redis to prevent Distributed DDOS attacks bypassing container RAM
        redis: fastify.redis || null,
        continueExceeding: true
    });
};
