/* middlewares/enterpriseAuth.js */
'use strict';

const Store = require('../models/Store');
const AppError = require('../utils/AppError');

/**
 * DailyPick - Enterprise B2B API Gateway Middleware
 * Intercepts requests from external ERP systems (e.g., Reliance, Croma) 
 * to programmatically sync inventory and fetch orders.
 */
exports.verifyEnterpriseKey = async (request, reply) => {
    const apiKey = request.headers['x-api-key'];
    
    if (!apiKey) {
        throw new AppError('Unauthorized: Missing Enterprise API Key in headers (x-api-key)', 401);
    }

    // Search for an active store that holds this specific secret key
    const store = await Store.findOne({ 
        'apiIntegration.apiSecretKey': apiKey, 
        isActive: true 
    });

    if (!store) {
        throw new AppError('Unauthorized: Invalid or Revoked Enterprise API Key', 403);
    }

    // Attach the verified store to the request so the controller knows exactly whose data to touch
    request.enterpriseStore = store;
};
