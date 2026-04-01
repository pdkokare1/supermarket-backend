/* utils/errorUtils.js */

const AppError = require('./AppError'); 

exports.handleControllerError = (request, reply, error, contextMessage) => {
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
