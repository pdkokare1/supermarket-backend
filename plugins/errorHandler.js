/* plugins/errorHandler.js */

// OPTIMIZATION: In-Memory Circuit Breaker State
let consecutiveErrors = 0;
let circuitTripped = false;
let breakerResetTimer = null;

const checkCircuitBreaker = (fastify) => {
    consecutiveErrors++;
    if (consecutiveErrors > 15 && !circuitTripped) {
        circuitTripped = true;
        fastify.log.fatal('[CIRCUIT BREAKER] Tripped due to cascading 500 errors. External interactions paused.');
        
        breakerResetTimer = setTimeout(() => {
            circuitTripped = false;
            consecutiveErrors = 0;
            fastify.log.info('[CIRCUIT BREAKER] Resetting state. Resuming normal operations.');
        }, 30000); // Wait 30 seconds before retrying broken services
    }
};

module.exports = function (fastify) {
    fastify.decorate('isCircuitTripped', () => circuitTripped);

    fastify.setErrorHandler(function (error, request, reply) {
        
        // DEPRECATION CONSULTATION: Previous handler lacked failure state tracking
        /*
        if (error.name === 'ValidationError') { ... }
        */

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

        const isServerError = !error.statusCode || error.statusCode >= 500;

        // OPTIMIZATION: Upgraded APM payload for enterprise tracing
        const apmLog = {
            event: isServerError ? 'CRITICAL_ERROR' : 'USER_ERROR',
            timestamp: new Date().toISOString(),
            reqId: request.id || 'Unknown',
            method: request.method,
            url: request.url,
            userId: request.user ? request.user.id : 'Unauthenticated',
            errorName: error.name,
            errorMessage: error.message,
            payload: request.body ? '[REDACTED]' : null 
        };
        
        if (isServerError) {
            fastify.log.error(`[APM MONITOR] ${JSON.stringify(apmLog)}`);
            if (process.env.NODE_ENV !== 'production') fastify.log.error(error); 
            checkCircuitBreaker(fastify); // Increment failure tracking
        } else {
            fastify.log.warn(`[CLIENT ERROR] ${error.statusCode} - ${error.message} - [REQ_ID: ${request.id}]`);
            consecutiveErrors = Math.max(0, consecutiveErrors - 1); // Recover state on successes
        }

        // OPTIMIZATION: Never leak raw database strings to the frontend during a crash
        const safeMessage = isServerError ? 'Internal Server Error. Our team has been notified.' : error.message;

        reply.status(error.statusCode || 500).send({
            success: false,
            message: safeMessage
        });
    });
};
