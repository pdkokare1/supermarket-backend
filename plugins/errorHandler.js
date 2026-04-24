/* plugins/errorHandler.js */
'use strict';

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

// OPTIMIZATION: O(1) Memory Set for sensitive lookups
const sensitiveKeys = new Set(['pin', 'password', 'token', 'customerPhone', 'apiKey']);

// ENTERPRISE FIX: Native V8 Serialization Redaction
// Effect: Replaces slow, memory-heavy recursive object cloning with an inline stringify replacer.
// This prevents high-concurrency requests from locking the thread when large error payloads are logged.
const redactPII = (body) => {
    if (!body) return null;
    try {
        return JSON.stringify(body, (key, value) => {
            if (sensitiveKeys.has(key) && typeof value === 'string') {
                return key === 'customerPhone' 
                    ? value.replace(/.(?=.{4})/g, '*') 
                    : '[REDACTED]';
            }
            return value;
        });
    } catch (e) {
        return '[UNPARSABLE_PAYLOAD]';
    }
};

module.exports = function (fastify) {
    fastify.decorate('isCircuitTripped', () => circuitTripped);

    fastify.addHook('onRequest', (request, reply, done) => {
        if (circuitTripped) {
            return reply.status(503).send({
                success: false,
                message: 'Service Unavailable: DailyPick systems are temporarily paused to prevent cascading failures. Please try again in 30 seconds.'
            });
        }
        done();
    });

    // ENTERPRISE FIX: Strict Health Reset
    // Effect: Prevents 4xx client errors or non-data endpoints from falsely resetting the failure state.
    fastify.addHook('onResponse', (request, reply, done) => {
        if (reply.statusCode === 200 || reply.statusCode === 201) {
            consecutiveErrors = 0;
        }
        done();
    });

    fastify.setErrorHandler(function (error, request, reply) {
        
        if (error.name === 'ValidationError') {
            error.statusCode = 400;
            error.message = Object.values(error.errors || {}).map(val => val.message).join(', ');
        } else if (error.name === 'CastError') {
            error.statusCode = 400;
            error.message = `Invalid ${error.path}: ${error.value}.`;
        } else if (error.code === 11000) {
            error.statusCode = 400;
            error.message = 'Duplicate field value entered. Please use another value.';
        }

        const isServerError = !error.statusCode || error.statusCode >= 500;

        const apmLog = {
            event: isServerError ? 'CRITICAL_ERROR' : 'USER_ERROR',
            timestamp: new Date().toISOString(),
            reqId: request.id || 'Unknown',
            method: request.method,
            url: request.url,
            userId: request.user ? request.user.id : 'Unauthenticated',
            errorName: error.name,
            errorMessage: error.message,
            payload: redactPII(request.body) 
        };
        
        if (isServerError) {
            fastify.log.error(`[APM MONITOR] ${JSON.stringify(apmLog)}`);
            if (process.env.NODE_ENV !== 'production') fastify.log.error(error); 
            checkCircuitBreaker(fastify); 
        } else {
            fastify.log.warn(`[CLIENT ERROR] ${error.statusCode} - ${error.message} - [REQ_ID: ${request.id}]`);
        }

        const safeMessage = isServerError ? 'Internal Server Error. Our team has been notified.' : error.message;

        reply.status(error.statusCode || 500).send({
            success: false,
            message: safeMessage
        });
    });
};
