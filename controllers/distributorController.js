/* controllers/distributorController.js */

const distributorService = require('../services/distributorService');
const catchAsync = require('../utils/catchAsync');

exports.getDistributors = catchAsync(async (request, reply) => {
    const distributors = await distributorService.getAllDistributors();
    return { success: true, count: distributors.length, data: distributors };
}, 'fetching distributors');

exports.createDistributor = catchAsync(async (request, reply) => {
    const newDistributor = await distributorService.createDistributor(request.body.name);
    // REMOVED: request.server.broadcastToPOS (Now handled by Service events)
    return { success: true, message: 'Distributor added', data: newDistributor };
}, 'creating distributor');

exports.processPayment = catchAsync(async (request, reply) => {
    const distributor = await distributorService.processPayment(request.params.id, request.body);
    // REMOVED: request.server.broadcastToPOS (Now handled by Service events)
    return { success: true, message: 'Payment logged successfully', data: distributor };
}, 'processing payment');
