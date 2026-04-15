/* plugins/errorHandler.js */

// OPTIMIZATION: In-Memory Circuit Breaker State
let consecutiveErrors = 0;
let circuitTripped = false;
let breakerResetTimer = null;

const checkCircuitBreaker = (fastify) => {
    consecutiveErrors++;
    if (consecutiveErrors > 15 && !circuitTripped) {
        circuitTripped = true;
        fastify.log.fatal('[CIRCUIT Breaker] Tripped due to cascading 500 errors. External interactions paused.');
        
        breakerResetTimer = setTimeout(() => {
            circuitTripped = false;
            consecutiveErrors = 0;
            fastify.log.info('[CIRCUIT Breaker] Resetting state. Resuming normal operations.');
        }, 30000); // Wait 30 seconds before retrying broken services
    }
};

module.exports = function (fastify) {
    fastify.decorate('isCircuitTripped', () => circuitTripped);

    // OPTIMIZATION: Circuit Breaker Interceptor. Aborts incoming requests instantly if the system is overloaded.
    fastify.addHook('onRequest', (request, reply, done) => {
        if (circuitTripped) {
            // Immediately reply with 503, preventing the request from executing controller or DB logic
            return reply.status(503).send({
                success: false,
                message: 'Service Unavailable: DailyPick systems are temporarily paused to prevent cascading failures. Please try again in 30 seconds.'
            });
        }
        done();
    });

    // OPTIMIZATION: Natively reset the circuit breaker state on any successful response
    fastify.addHook('onResponse', (request, reply, done) => {
        if (reply.statusCode >= 200 && reply.statusCode < 400) {
            consecutiveErrors = 0;
        }
        done();
    });

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
        }

        // OPTIMIZATION: Never leak raw database strings to the frontend during a crash
        const safeMessage = isServerError ? 'Internal Server Error. Our team has been notified.' : error.message;

        reply.status(error.statusCode || 500).send({
            success: false,
            message: safeMessage
        });
    });
};
