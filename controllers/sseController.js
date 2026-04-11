/* controllers/sseController.js */
'use strict';

const sseService = require('../services/orderSseService');

exports.streamAdmin = async (request, reply) => {
    sseService.initializeAdminStream(request, reply);
};

exports.streamCustomer = async (request, reply) => {
    sseService.initializeCustomerStream(request, reply, request.params.id);
};
