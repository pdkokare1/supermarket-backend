/* controllers/marketplaceController.js */
'use strict';

const User = require('../models/User');
const Store = require('../models/Store');
const AppError = require('../utils/AppError');

// --- FLEET OPERATIONS ---
// Called by the Rider's phone every 10-30 seconds to update their location on the map
exports.pingLocation = async (request, reply) => {
    const userId = request.user._id;
    const { lat, lng } = request.body;

    if (request.user.role !== 'Delivery_Agent') {
        throw new AppError('Access Denied: Only Delivery Agents can transmit live fleet coordinates.', 403);
    }

    if (!lat || !lng) {
        throw new AppError('Latitude and longitude are required to ping location.', 400);
    }

    // Atomic update to prevent race conditions during high-frequency pings
    await User.findByIdAndUpdate(userId, {
        $set: {
            "liveLocation.lat": Number(lat),
            "liveLocation.lng": Number(lng),
            "liveLocation.lastPingedAt": new Date()
        }
    });

    return { success: true, message: 'Fleet location tracked securely.' };
};

// --- MARKETPLACE TRUST ---
// Called by the B2C Frontend when a user reviews their completed delivery
exports.rateStore = async (request, reply) => {
    const { storeId, rating } = request.body;

    if (!storeId || rating === undefined || rating < 1 || rating > 5) {
        throw new AppError('Valid storeId and rating (between 1 and 5) are required.', 400);
    }

    const store = await Store.findById(storeId);
    if (!store) {
        throw new AppError('Store not found.', 404);
    }

    // Mathematical recalculation of the Store's average rating
    const currentTotalReviews = store.metrics?.totalReviews || 0;
    const currentRating = store.metrics?.rating || 0;

    const newTotalReviews = currentTotalReviews + 1;
    const newRating = ((currentRating * currentTotalReviews) + Number(rating)) / newTotalReviews;

    // Save back to the database
    store.metrics = {
        rating: Number(newRating.toFixed(1)),
        totalReviews: newTotalReviews
    };

    await store.save();

    // Cache invalidation could be added here if stores are heavily cached on the frontend
    return { success: true, message: 'Store rated successfully.', data: store.metrics };
};
