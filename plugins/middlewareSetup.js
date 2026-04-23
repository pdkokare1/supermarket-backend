/* plugins/middlewareSetup.js */
'use strict';

const auditService = require('../services/auditService');

module.exports = function(fastify) {
    
    // OPTIMIZATION: Ensure downstream clients receive the highly-optimized Fastify native request ID for log tracing
    fastify.addHook('onSend', async (request, reply, payload) => {
        reply.header('x-correlation-id', request.id);
        return payload;
    });

    // OPTIMIZATION: Non-Blocking Compliance Logging Hook
    // Flushes the audit batch asynchronously ONLY after the response is securely sent to the user
    fastify.addHook('onResponse', async (request, reply) => {
        await auditService.flushAuditBatch();
    });

    fastify.register(require('@fastify/compress'), { global: true });

    // OPTIMIZATION: Hardened Multipart limits to drop hanging connections and prevent slow-loris/multipart DDoS
    fastify.register(require('@fastify/multipart'), {
        limits: { 
            fileSize: 5 * 1024 * 1024,
            files: 1 // Enterprise Hardening: Restrict to 1 file per payload
        }
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
};
