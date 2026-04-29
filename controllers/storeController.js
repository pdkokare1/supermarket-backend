/* controllers/storeController.js */

const storeService = require('../services/storeService');
const Store = require('../models/Store'); 
const crypto = require('crypto'); 
const AppError = require('../utils/AppError'); 

exports.getStores = async (request, reply) => {
    const { lat, lng, radius } = request.query;
    let stores;

    // DYNAMIC B2C ROUTING
    if (lat && lng) {
        stores = await storeService.getNearbyStores(Number(lat), Number(lng), radius ? Number(radius) : 5);
    } else {
        stores = await storeService.getAllActiveStores();
    }

    return { success: true, data: stores };
};

exports.createStore = async (request, reply) => {
    const newStore = await storeService.createStore(request.body);
    return { success: true, message: 'Store created successfully', data: newStore };
};

exports.raiseDispute = async (request, reply) => {
    const storeId = request.user.tenantId; 
    
    if (!storeId) {
        return reply.status(403).send({ success: false, message: 'Only authorized store tenants can raise a dispute.' });
    }

    const { orderId, disputeReason } = request.body;
    const settlement = await storeService.raiseDispute(storeId, orderId, disputeReason);
    
    return { success: true, message: 'Dispute raised successfully. Payout frozen pending review.', data: settlement };
};

// --- ENTERPRISE API KEY GENERATOR ---
exports.generateEnterpriseKey = async (request, reply) => {
    const targetStoreId = request.params.id;

    // Security Guardrail: Allow SuperAdmins OR the specific Store Admin to generate keys
    const isSuperAdmin = request.user.role === 'SuperAdmin';
    const isStoreAdmin = request.user.role === 'Admin' && request.user.tenantId === targetStoreId;

    if (!isSuperAdmin && !isStoreAdmin) {
        throw new AppError('Unauthorized: Insufficient privileges to generate Enterprise Keys', 403);
    }

    const store = await Store.findById(targetStoreId);
    
    if (!store) {
        throw new AppError('Target store not found', 404);
    }

    // Generate a secure 64-character hexadecimal key
    const newApiKey = 'dp_ent_' + crypto.randomBytes(32).toString('hex');

    // Attach to the store profile
    store.apiIntegration = {
        ...store.apiIntegration,
        apiSecretKey: newApiKey
    };
    
    await store.save();

    return { success: true, message: 'Enterprise API Key generated successfully.', data: { apiKey: newApiKey } };
};

// ============================================================================
// --- NEW: PHASE 10 HYPER-LOCAL DISCOVERY API (MOBILE APP READY) ---
// ============================================================================
exports.discoverNearbyStores = async (request, reply) => {
    const { lat, lng, radius = 5000 } = request.query; // Default 5km radius
    
    if (!lat || !lng) {
        throw new AppError('Latitude and Longitude are strictly required for spatial discovery.', 400);
    }

    // Use MongoDB native geospatial aggregation to find and categorize stores
    const nearbyStores = await Store.aggregate([
        {
            $geoNear: {
                near: { type: 'Point', coordinates: [Number(lng), Number(lat)] },
                distanceField: "distanceInMeters",
                maxDistance: Number(radius),
                spherical: true,
                query: { isActive: true } // Only show active platforms
            }
        },
        {
            // Dynamic distance validation against the store's custom multi-tenant delivery radius constraint
            $match: {
                $expr: { $lte: ["$distanceInMeters", { $ifNull: ["$maxDeliveryRadius", 5000] }] }
            }
        },
        {
            // Optimize payload for lightweight mobile app consumption
            $project: {
                name: 1,
                storeType: 1,
                chainName: 1,
                distanceInMeters: 1,
                "metrics.rating": 1,
                fulfillmentOptions: 1
            }
        },
        { $sort: { distanceInMeters: 1 } }
    ]);

    // Grouping the response so the UI team can easily render distinct horizontal scrolling sections
    const groupedResults = {
        megaMarts: nearbyStores.filter(s => s.storeType === 'ENTERPRISE'),
        quickCommerce: nearbyStores.filter(s => s.storeType === 'INDEPENDENT' && s.distanceInMeters < 3000), // Under 3km
        allNearby: nearbyStores
    };

    return { success: true, message: 'Hyper-local discovery complete', data: groupedResults };
};
