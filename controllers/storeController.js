/* controllers/storeController.js */

const storeService = require('../services/storeService');

exports.getStores = async (request, reply) => {
    const { lat, lng, radius } = request.query;
    let stores;

    // --- NEW: DYNAMIC B2C ROUTING ---
    // If the frontend app sends the customer's GPS, only return stores in their delivery zone.
    if (lat && lng) {
        stores = await storeService.getNearbyStores(Number(lat), Number(lng), radius ? Number(radius) : 5);
    } else {
        // Fallback: If no GPS is sent, behave normally (used by SuperAdmin dashboards)
        stores = await storeService.getAllActiveStores();
    }

    return { success: true, data: stores };
};

exports.createStore = async (request, reply) => {
    const newStore = await storeService.createStore(request.body);
    return { success: true, message: 'Store created successfully', data: newStore };
};

// --- NEW: TENANT DISPUTE ENDPOINT ---
exports.raiseDispute = async (request, reply) => {
    // Ensure the tenant can only dispute their own orders using their auth token
    const storeId = request.user.tenantId; 
    
    if (!storeId) {
        return reply.status(403).send({ success: false, message: 'Only authorized store tenants can raise a dispute.' });
    }

    const { orderId, disputeReason } = request.body;
    
    const settlement = await storeService.raiseDispute(storeId, orderId, disputeReason);
    
    return { success: true, message: 'Dispute raised successfully. Payout frozen pending review.', data: settlement };
};
