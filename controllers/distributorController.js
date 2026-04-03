/* controllers/distributorController.js */

const distributorService = require('../services/distributorService');
const catchAsync = require('../utils/catchAsync');

exports.getDistributors = catchAsync(async (request, reply) => {
    const distributors = await distributorService.getAllDistributors();
    return { success: true, count: distributors.length, data: distributors };
}, 'fetching distributors');

exports.createDistributor = catchAsync(async (request, reply) => {
    const newDistributor = await distributorService.createDistributor(request.body.name);
    if (request.server.broadcastToPOS) request.server.broadcastToPOS({ type: 'DISTRIBUTOR_ADDED', distributorId: newDistributor._id });
    return { success: true, message: 'Distributor added', data: newDistributor };
}, 'creating distributor');

exports.processPayment = catchAsync(async (request, reply) => {
    const distributor = await distributorService.processPayment(request.params.id, request.body);
    if (request.server.broadcastToPOS) request.server.broadcastToPOS({ type: 'DISTRIBUTOR_UPDATED', distributorId: distributor._id });
    return { success: true, message: 'Payment logged successfully', data: distributor };
}, 'processing payment');
