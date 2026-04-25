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
