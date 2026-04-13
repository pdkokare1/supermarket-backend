/* services/storeService.js */

const Store = require('../models/Store');
const AppError = require('../utils/AppError');
const cacheUtils = require('../utils/cacheUtils'); // OPTIMIZATION: Added for caching
const appEvents = require('../utils/eventEmitter'); // OPTIMIZATION: Added for ecosystem consistency

exports.getAllActiveStores = async () => {
    // OPTIMIZATION: Cache the store list to prevent unnecessary DB reads.
    const CACHE_KEY = 'stores:active';
    let stores = await cacheUtils.getCachedData(CACHE_KEY);
    
    if (!stores) {
        // OPTIMIZATION: Appended .lean() to bypass heavy Mongoose Document instantiation
        stores = await Store.find({ isActive: true }).sort({ name: 1 }).lean();
        await cacheUtils.setCachedData(CACHE_KEY, stores, 86400); // Cache for 24 hours
    }
    
    return stores;
};

exports.createStore = async (payload) => {
    const { name, location, contactNumber } = payload;
    
    if (!name || !location) {
        throw new AppError('Store Name and Location are required', 400);
    }

    const newStore = new Store({ name, location, contactNumber: contactNumber || '' });
    await newStore.save();
    
    // OPTIMIZATION: Invalidate store cache so the new location appears immediately
    await cacheUtils.deleteKey('stores:active');
    
    // EVENT: Notify the broader system of network expansion
    appEvents.emit('STORE_ADDED', { storeId: newStore._id, storeName: newStore.name });

    return newStore;
};
