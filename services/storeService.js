/* services/storeService.js */

const Store = require('../models/Store');
const Settlement = require('../models/Settlement'); // NEW: For dispute flow integration
const Order = require('../models/Order'); // NEW: For return state updates
const AppError = require('../utils/AppError');
const cacheUtils = require('../utils/cacheUtils'); 
const appEvents = require('../utils/eventEmitter'); 

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

// --- NEW: HYPER-LOCAL GEOSPATIAL FENCING ---
exports.getNearbyStores = async (userLat, userLng, radiusInKm = 5) => {
    // High-speed bounding box calculation (1 degree of latitude is roughly 111km)
    const latDelta = radiusInKm / 111;
    const lngDelta = radiusInKm / (111 * Math.cos(userLat * (Math.PI / 180)));

    // Find active stores within the bounding box using the coordinates index we built earlier
    const stores = await Store.find({
        isActive: true,
        "coordinates.lat": { $gte: userLat - latDelta, $lte: userLat + latDelta },
        "coordinates.lng": { $gte: userLng - lngDelta, $lte: userLng + lngDelta }
    }).lean();

    // In-memory Haversine distance filter for exact radius precision
    const nearbyStores = stores.filter(store => {
        if (!store.coordinates || !store.coordinates.lat || !store.coordinates.lng) return false;
        
        const p = 0.017453292519943295; // Math.PI / 180
        const c = Math.cos;
        const a = 0.5 - c((store.coordinates.lat - userLat) * p)/2 + 
                  c(userLat * p) * c(store.coordinates.lat * p) * (1 - c((store.coordinates.lng - userLng) * p))/2;
        const distance = 12742 * Math.asin(Math.sqrt(a)); // 2 * R; R = 6371 km
        
        return distance <= radiusInKm;
    });

    return nearbyStores;
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

// --- NEW: THE REVERSE LOGISTICS & DISPUTE FLOW ---
exports.raiseDispute = async (storeId, orderId, disputeReason) => {
    if (!storeId || !orderId || !disputeReason) {
        throw new AppError('Store ID, Order ID, and Dispute Reason are required', 400);
    }

    // 1. Immediately freeze the automated payout to the store for this specific order
    const settlement = await Settlement.findOneAndUpdate(
        { storeId, orderId },
        { $set: { status: 'Disputed', disputeReason: disputeReason } },
        { new: true }
    );

    if (!settlement) {
        throw new AppError('Settlement record not found. It may have already been processed to the bank.', 404);
    }

    // 2. Mark the B2C order as Returned
    await Order.findByIdAndUpdate(orderId, { $set: { status: 'Returned' } });

    // 3. Alert platform operations
    appEvents.emit('SETTLEMENT_DISPUTED', { storeId, orderId, disputeReason });

    return settlement;
};
