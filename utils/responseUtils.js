/* utils/responseUtils.js */
'use strict';

/**
 * Standardizes the order response format across the application.
 */
exports.handleOrderResponse = (reply, order, successMessage = null) => {
    if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });
    const response = { success: true, data: order };
    if (successMessage) response.message = successMessage;
    return response;
};
