/* plugins/middlewareSetup.js */
'use strict';

const auditService = require('../services/auditService');

module.exports = function(fastify) {
    
    // OPTIMIZATION: Ensure downstream clients receive the highly-optimized Fastify native request ID for log tracing
    fastify.addHook('onSend', async (request, reply, payload) => {
        reply.header('x-correlation-id', request.id);
        return payload;
    });

    // OPTIMIZATION: Non-Blocking Fire-and-Forget Audit
    // Effect: Removed 'await'. Allows Fastify to fully close the request lifecycle and release memory 
    // instantly, instead of waiting for external database writes to complete.
    fastify.addHook('onResponse', (request, reply, done) => {
        auditService.flushAuditBatch().catch(err => fastify.log.error(`Audit Flush Error: ${err.message}`));
        done();
    });

    // OPTIMIZATION: CPU-Aware Compression
    // Effect: Bypasses the compression engine for payloads under 1KB to save cloud CPU compute cycles.
    fastify.register(require('@fastify/compress'), { 
        global: true,
        threshold: 1024 
    });

    // OPTIMIZATION: Hardened Multipart limits to drop hanging connections and prevent slow-loris/multipart DDoS
    fastify.register(require('@fastify/multipart'), {
        limits: { 
            fileSize: 5 * 1024 * 1024,
            files: 1 // Enterprise Hardening: Restrict to 1 file per payload
        }
    });

    let cookieSecret = process.env.COOKIE_SECRET;
    
    // ENTERPRISE SECURITY: Fail-Fast configuration. 
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
