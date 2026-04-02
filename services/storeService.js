/* services/storeService.js */

const Store = require('../models/Store');
const AppError = require('../utils/AppError');

exports.getAllActiveStores = async () => {
    return await Store.find({ isActive: true }).sort({ name: 1 });
};

exports.createStore = async (payload) => {
    const { name, location, contactNumber } = payload;
    
    if (!name || !location) {
        throw new AppError('Store Name and Location are required', 400);
    }

    const newStore = new Store({ name, location, contactNumber: contactNumber || '' });
    await newStore.save();
    
    return newStore;
};
