/* plugins/errorHandler.js */

module.exports = function (fastify) {
    fastify.setErrorHandler(function (error, request, reply) {
        
        // OPTIMIZATION: Gracefully handle standard MongoDB user-input errors without causing 500s
        if (error.name === 'ValidationError') {
            error.statusCode = 400;
            error.message = Object.values(error.errors).map(val => val.message).join(', ');
        } else if (error.name === 'CastError') {
            error.statusCode = 400;
            error.message = `Invalid ${error.path}: ${error.value}.`;
        } else if (error.code === 11000) {
            error.statusCode = 400;
            error.message = 'Duplicate field value entered. Please use another value.';
        }

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
        
        // OPTIMIZATION: Only log as CRITICAL if it's an actual 500 crash, not a 400 user typo
        if (!error.statusCode || error.statusCode >= 500) {
            fastify.log.error(`[APM MONITOR] ${JSON.stringify(apmLog)}`);
            if (process.env.NODE_ENV !== 'production') fastify.log.error(error); 
        } else {
            fastify.log.warn(`[CLIENT ERROR] ${error.statusCode} - ${error.message} - ${request.url}`);
        }

        reply.status(error.statusCode || 500).send({
            success: false,
            message: error.message || 'Internal Server Error'
        });
    });
};
