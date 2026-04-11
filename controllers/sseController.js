/* controllers/sseController.js */
'use strict';

const sseService = require('../services/orderSseService');

/**
 * Initializes the SSE stream for Admin panel notifications.
 */
exports.streamAdmin = async (request, reply) => {
    sseService.initializeAdminStream(request, reply);
};

/**
 * Initializes the SSE stream for specific Customer tracking.
 */
exports.streamCustomer = async (request, reply) => {
    sseService.initializeCustomerStream(request, reply, request.params.id);
};
