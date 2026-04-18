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

    // CORS & Helmet are disabled here as they are correctly managed in securitySetup.js.

    fastify.register(require('@fastify/compress'), { global: true });

    fastify.register(require('@fastify/multipart'), {
        limits: { fileSize: 5 * 1024 * 1024 }
    });

    let cookieSecret = process.env.COOKIE_SECRET;
    
    // ENTERPRISE SECURITY: Fail-Fast configuration. 
    // Never allow the container to boot with a hardcoded public string in production.
    if (process.env.NODE_ENV === 'production' && !cookieSecret) {
        fastify.log.fatal("CRITICAL SECURITY ALERT: Missing COOKIE_SECRET in production. Server shutting down to prevent session hijacking vulnerabilities.");
        process.exit(1);
    } else if (!cookieSecret) {
        cookieSecret = 'dev-fallback-secret-123';
    }
    
    fastify.register(require('@fastify/cookie'), {
        secret: cookieSecret,
        hook: 'onRequest'
    });

    fastify.register(require('@fastify/websocket'));
    
    // OPTIMIZATION: Deleted duplicate @fastify/swagger and @fastify/swagger-ui 
    // configurations to prevent fatal duplicate plugin crashes, as Swagger is
    // correctly managed in plugins/apiDocsSetup.js.
};
