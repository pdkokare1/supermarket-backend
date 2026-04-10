/* plugins/serverUtilsSetup.js */
'use strict';

module.exports = function(fastify) {
    fastify.register(require('@fastify/compress'), { global: true });
    fastify.register(require('@fastify/multipart'), { limits: { fileSize: 5 * 1024 * 1024 } });

    let cookieSecret = process.env.COOKIE_SECRET || (process.env.NODE_ENV === 'production' ? 'production-fallback-secret-1234567890' : 'dev-fallback-secret-123');
    
    fastify.register(require('@fastify/cookie'), { secret: cookieSecret, hook: 'onRequest' });
    fastify.register(require('@fastify/websocket'));
};
