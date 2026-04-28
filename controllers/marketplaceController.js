/* controllers/marketplaceController.js */
'use strict';

const User = require('../models/User');
const Store = require('../models/Store');
const StoreInventory = require('../models/StoreInventory');
const MasterProduct = require('../models/MasterProduct');
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

    return { success: true, message: 'Store rated successfully.', data: store.metrics };
};

// --- NEW: PHASE 2 STORE-IN-STORE AGGREGATOR ---
// Called when a B2C user clicks a specific mega-outlet tile (e.g., D-Mart)
exports.getStorefront = async (request, reply) => {
    const { storeId } = request.params;
    const { category, page = 1, limit = 50 } = request.query;

    if (!storeId) throw new AppError('Store ID is required to load the storefront.', 400);

    const store = await Store.findById(storeId).lean();
    if (!store || !store.isActive) throw new AppError('Store is offline or not found.', 404);

    const query = { storeId: store._id, status: 'in_stock' };

    // Fetch the local inventory, seamlessly merging it with Global Truth (images, names)
    const inventory = await StoreInventory.find(query)
        .populate({
            path: 'masterProductId',
            match: category ? { category: category } : {},
            select: 'name brand description imageUrl variants'
        })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean();

    // Filter out items if a category was specified and didn't match
    const products = inventory.filter(inv => inv.masterProductId !== null);

    return { success: true, storeName: store.name, data: products };
};

// --- NEW: PHASE 2 CROSS-STORE PRICE ENGINE ---
// The Core feature: Queries all active stores within a geofence for the same Global Product
exports.comparePrices = async (request, reply) => {
    const { sku, lat, lng, radiusKm = 5 } = request.query;

    if (!sku || !lat || !lng) throw new AppError('SKU, Latitude, and Longitude are required.', 400);

    // 1. Safe Bounding Box Calculation for Hyper-Local Discovery
    const latNum = Number(lat);
    const lngNum = Number(lng);
    const delta = Number(radiusKm) * 0.01; // Approx 1km per 0.01 degree

    const nearbyStores = await Store.find({
        "coordinates.lat": { $gte: latNum - delta, $lte: latNum + delta },
        "coordinates.lng": { $gte: lngNum - delta, $lte: lngNum + delta },
        isActive: true
    }).select('_id name storeType metrics').lean();

    const storeIds = nearbyStores.map(s => s._id);
    if (storeIds.length === 0) return { success: true, message: 'No stores found nearby.', data: [] };

    // 2. Query the Global Catalog
    const masterDoc = await MasterProduct.findOne({ "variants.sku": sku }).lean();
    if (!masterDoc) throw new AppError('Global product not found.', 404);

    // 3. Find which nearby stores have this in stock
    const localInventories = await StoreInventory.find({
        storeId: { $in: storeIds },
        masterProductId: masterDoc._id,
        status: 'in_stock',
        stockCount: { $gt: 0 }
    }).populate('storeId', 'name storeType metrics fulfillmentOptions').lean();

    // 4. Sort by the lowest price (in Rs) to give the user the ultimate truth
    const aggregatedResults = localInventories.map(inv => ({
        storeName: inv.storeId.name,
        storeType: inv.storeId.storeType,
        rating: inv.storeId.metrics?.rating || 0,
        fulfillment: inv.storeId.fulfillmentOptions,
        mrp: inv.mrp,
        bestPriceRs: inv.sellingPrice,
        stockRemaining: inv.stockCount,
        storeId: inv.storeId._id
    })).sort((a, b) => a.bestPriceRs - b.bestPriceRs);

    return { 
        success: true, 
        globalProduct: { name: masterDoc.name, image: masterDoc.imageUrl },
        options: aggregatedResults 
    };
};
