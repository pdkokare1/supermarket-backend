/* plugins/apiDocsSetup.js */
'use strict';

module.exports = function(fastify) {
    fastify.register(require('@fastify/swagger'), {
        swagger: {
            info: { title: 'DailyPick API', description: 'Enterprise Backend API', version: '1.0.0' },
            consumes: ['application/json'],
            produces: ['application/json']
        }
    });
    fastify.register(require('@fastify/swagger-ui'), { routePrefix: '/api/docs', uiConfig: { docExpansion: 'none' } });
};
