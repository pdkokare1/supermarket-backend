/* utils/errorUtils.js */

const AppError = require('./AppError'); 

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

    // 1. Handle our new standardized AppError
    if (error instanceof AppError) {
        return reply.status(error.statusCode).send({ success: false, message: error.message });
    }

    // 2. Legacy fallbacks to ensure nothing breaks during transition
    if (error.status) {
        return reply.status(error.status).send({ success: false, message: error.message });
    }
    if (error.statusCode) {
        return reply.status(error.statusCode).send({ success: false, message: error.message });
    }

    // 3. Default 500 Server Error
    request.server.log.error(`[${contextMessage}] Error:`, error);
    reply.status(500).send({ success: false, message: `Server Error: ${contextMessage.toLowerCase()}` });
};
