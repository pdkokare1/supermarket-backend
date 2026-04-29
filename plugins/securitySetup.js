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
    
    // --- NEW: DYNAMIC CORS BYPASS ---
    // Automatically authorizes your Vercel and HQ deployments
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
            
            // --- NEW: Firewall unblocker for frontend clusters ---
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
            'x-enterprise-api-key', // NEW: Unblocks Enterprise ERP integrations
            'x-tenant-id',          // NEW: Unblocks Tenant Isolation tracking
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

// ============================================================================
// --- NEW: PHASE 14 STRICT MULTI-FRONTEND FIREWALL ---
// ============================================================================
const originalSecuritySetupPhase14 = module.exports;

module.exports = function(fastify) {
    originalSecuritySetupPhase14(fastify);

    // Hardened pre-flight origin check
    fastify.addHook('onRequest', async (request, reply) => {
        const origin = request.headers.origin;
        if (!origin) return; // Allow backend-to-backend / cURL traffic

        const isProduction = process.env.NODE_ENV === 'production';
        if (!isProduction) return; // Bypass in local dev

        const strictAllowedDomains = process.env.FRONTEND_URLS 
            ? process.env.FRONTEND_URLS.split(',').map(url => url.trim())
            : [];

        if (strictAllowedDomains.length > 0 && !strictAllowedDomains.includes(origin)) {
            fastify.log.warn(`[FIREWALL] Blocked unauthorized cross-origin request from: ${origin}`);
            return reply.status(403).send({ 
                success: false, 
                error: "Access Denied", 
                message: "This domain is not whitelisted in the DailyPick infrastructure." 
            });
        }
    });
};
