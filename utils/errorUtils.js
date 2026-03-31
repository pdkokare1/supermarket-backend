/* utils/errorUtils.js */

exports.handleControllerError = (request, reply, error, contextMessage) => {
    // Handle specific HTTP statuses (e.g., from authService)
    if (error.status) {
        return reply.status(error.status).send({ success: false, message: error.message });
    }
    // Handle custom status codes (e.g., from orderService)
    if (error.statusCode) {
        return reply.status(error.statusCode).send({ success: false, message: error.message });
    }
    // Handle specific string messages (e.g., from customerService)
    if (error.message === 'Customer not found.' || error.message.includes('not found')) {
        return reply.status(404).send({ success: false, message: error.message });
    }

    // Default 500 Server Error
    request.server.log.error(`[${contextMessage}] Error:`, error);
    reply.status(500).send({ success: false, message: `Server Error: ${contextMessage.toLowerCase()}` });
};
