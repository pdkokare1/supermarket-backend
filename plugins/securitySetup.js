/* plugins/securitySetup.js */
'use strict';

const threatDefenseService = require('../services/threatDefenseService');

module.exports = function(fastify) {
    
    // OPTIMIZATION: Parse origins once at startup into an O(1) lookup Set.
    // Consolidated Phase 14 FRONTEND_URLS into the primary allowed origins set.
    const rawOrigins = [
        ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
        ...(process.env.FRONTEND_URLS ? process.env.FRONTEND_URLS.split(',') : [])
    ];
    
    const allowedOriginsSet = new Set(
        rawOrigins.map(o => o.trim().replace(/\/$/, ''))
    );
    
    const isLocalDev = /^https?:\/\/localhost:\d+$/;
    const isVercelOrHQ = /^https:\/\/(.*\.vercel\.app|hq\..*\.com|hq\..*\.net)$/;

    fastify.register(require('@fastify/cors'), { 
        origin: (origin, cb) => {
            if (!origin || allowedOriginsSet.has(origin)) {
                cb(null, true);
                return;
            }
            if (process.env.NODE_ENV !== 'production' && isLocalDev.test(origin)) {
                cb(null, true);
                return;
            }
            if (isVercelOrHQ.test(origin)) {
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
            'x-enterprise-api-key', 
            'x-tenant-id',          
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
                // ENTERPRISE FIX: Whitelisted required external services for DailyPick
                imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
                mediaSrc: ["'self'", "https://res.cloudinary.com"],
                connectSrc: ["'self'", "https://*.firebaseapp.com", "https://*.googleapis.com", "https://res.cloudinary.com"],
                objectSrc: ["'none'"],
                frameAncestors: ["'none'"], 
                upgradeInsecureRequests: [],
            },
        },
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
        hidePoweredBy: true
    });

    fastify.register(require('@fastify/rate-limit'), {
        // ============================================================================
        // --- NEW: PHASE 17 ENTERPRISE ERP RATE LIMITING SHIELD ---
        // ============================================================================
        max: function (request, key) {
            // Give machine-to-machine integrations massive capacity to ingest catalogs
            if (request.url && (request.url.startsWith('/api/enterprise') || request.url.startsWith('/webhooks'))) {
                return 5000; // 5000 RPM for bulk ERP syncing
            }
            // Strict defense against DDoS for public-facing customer & admin routes
            return 100; // Standard 100 RPM
        },
        timeWindow: '1 minute',
        ban: 3, 
        hook: 'preHandler', 
        keyGenerator: function (request) {
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

    // ENTERPRISE FIX: Replaced greedy regex with exact string matching.
    const maliciousPaths = ['/.env', '/wp-admin', '/wp-login.php', '/config.json'];
    maliciousPaths.forEach(trapPath => {
        fastify.all(trapPath, async (request, reply) => {
            await threatDefenseService.triggerHoneypot(request.ip);
            return reply.status(403).send({ success: false, message: 'Forbidden' });
        });
    });
};
