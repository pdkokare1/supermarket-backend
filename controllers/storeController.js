/* controllers/storeController.js */

const storeService = require('../services/storeService');
const catchAsync = require('../utils/catchAsync');

exports.getStores = catchAsync(async (request, reply) => {
    const stores = await storeService.getAllActiveStores();
    return { success: true, data: stores };
}, 'fetching stores');

exports.createStore = catchAsync(async (request, reply) => {
    const newStore = await storeService.createStore(request.body);
    return { success: true, message: 'Store created successfully', data: newStore };
}, 'creating store');
