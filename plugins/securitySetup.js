/* plugins/securitySetup.js */
'use strict';

module.exports = function(fastify) {
    
    // DEPRECATION CONSULTATION: Static comma-separated list doesn't scale well with dynamic Vercel preview URLs.
    /*
    const allowedOrigins = process.env.ALLOWED_ORIGINS 
        ? process.env.ALLOWED_ORIGINS.split(',') 
        : true; 
    */

    // OPTIMIZATION: Enterprise CORS allowing the production Hostinger URL + Vercel dynamic previews
    const dynamicOriginAuth = (origin, cb) => {
        // Allow requests with no origin (e.g., mobile apps, curl, server-to-server)
        if (!origin) return cb(null, true);
        
        // Fallback for local development
        if (process.env.NODE_ENV !== 'production') return cb(null, true);

        const envOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
        
        // Authorize explicitly whitelisted origins
        if (envOrigins.includes(origin)) return cb(null, true);

        // Authorize any dynamic Vercel frontend branch previews
        if (origin.includes('vercel.app')) return cb(null, true);
        
        // Authorize custom Hostinger URLs
        if (origin.includes('hostinger')) return cb(null, true);

        // Reject all other unauthorized domains gracefully without crashing the request pipeline
        // Fixes the CORS block error in the browser
        cb(null, false);
    };

    fastify.register(require('@fastify/cors'), { 
        origin: dynamicOriginAuth,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'x-api-key', 'Idempotency-Key'],
        optionsSuccessStatus: 204 
    });

    fastify.register(require('@fastify/helmet'), {
        crossOriginResourcePolicy: { policy: "cross-origin" },
        crossOriginOpenerPolicy: { policy: "unsafe-none" },
        contentSecurityPolicy: false 
    });

    fastify.register(require('@fastify/rate-limit'), {
        max: 100,
        timeWindow: '1 minute',
        // OPTIMIZATION: DDOS Protection - Correctly resolve IPs behind Railway load balancers
        keyGenerator: function (request) {
            // Because trustProxy is true in app.js, Fastify safely parses the correct client IP.
            // Using request.headers directly here can fail if Railway sends an array of proxies.
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
        
        // DEPRECATION CONSULTATION: The dynamic fallback approach could silently revert to local RAM 
        // if Redis initializes late, breaking horizontal load balancer limits. 
        /* ...(fastify.redis && { redis: fastify.redis }) */
        
        // OPTIMIZATION: Explicitly link global Redis to prevent Distributed DDOS attacks bypassing container RAM
        redis: fastify.redis || null
    });
};
