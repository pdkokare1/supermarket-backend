/* controllers/storeController.js */

const storeService = require('../services/storeService');

exports.getStores = async (request, reply) => {
    const stores = await storeService.getAllActiveStores();
    return { success: true, data: stores };
};

exports.createStore = async (request, reply) => {
    const newStore = await storeService.createStore(request.body);
    return { success: true, message: 'Store created successfully', data: newStore };
};
