/* utils/errorUtils.js */

const AppError = require('./AppError'); 

// DEPRECATION CONSULTATION: Original utility
/*
exports.handleControllerError = (request, reply, error, contextMessage) => { ... }
*/

exports.handleControllerError = (request, reply, error, contextMessage) => {
    // OPTIMIZATION: Intercept MongoDB-specific errors automatically to prevent unhandled rejections
    if (error.name === 'CastError') {
        return reply.status(400).send({ success: false, message: `Invalid ${error.path}: ${error.value}` });
    }
    if (error.name === 'ValidationError') {
        const messages = Object.values(error.errors).map(val => val.message);
        return reply.status(400).send({ success: false, message: `Invalid input data. ${messages.join('. ')}` });
    }
    if (error.code === 11000) {
        const value = error.errmsg ? error.errmsg.match(/(["'])(\\?.)*?\1/)[0] : 'Duplicate field';
        return reply.status(400).send({ success: false, message: `Duplicate field value: ${value}. Please use another value.` });
    }

    // OPTIMIZATION: Operational Error Classification
    // Safe to return directly to the user because we explicitly wrote these strings.
    if (error instanceof AppError) {
        return reply.status(error.statusCode).send({ success: false, message: error.message });
    }

    // Legacy fallbacks to ensure nothing breaks during transition
    if (error.status && error.status < 500) {
        return reply.status(error.status).send({ success: false, message: error.message });
    }
    if (error.statusCode && error.statusCode < 500) {
        return reply.status(error.statusCode).send({ success: false, message: error.message });
    }

    // OPTIMIZATION: Programming Error Containment
    // DO NOT send stack traces or core database crash strings to the client. Route to global handler.
    request.server.log.error(`[${contextMessage}] Fatal Stack Trace:`, error);
    
    // Explicitly throw so the global errorHandler.js can trigger the Circuit Breaker APM
    throw error; 
};
