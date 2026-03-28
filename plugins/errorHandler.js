/* plugins/errorHandler.js */

module.exports = function (fastify) {
    fastify.setErrorHandler(function (error, request, reply) {
        const apmLog = {
            event: 'CRITICAL_ERROR',
            timestamp: new Date().toISOString(),
            method: request.method,
            url: request.url,
            userId: request.user ? request.user.id : 'Unauthenticated',
            errorName: error.name,
            errorMessage: error.message,
            payload: request.body ? '[REDACTED]' : null 
        };
        
        fastify.log.error(`[APM MONITOR] ${JSON.stringify(apmLog)}`);
        if (process.env.NODE_ENV !== 'production') fastify.log.error(error); 

        reply.status(error.statusCode || 500).send({
            success: false,
            message: error.message || 'Internal Server Error'
        });
    });
};
