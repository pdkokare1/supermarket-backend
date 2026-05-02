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

    let store = null;
    const redis = request.server ? request.server.redis : null;
    const cacheKey = `enterprise_auth:${apiKey}`;

    // ENTERPRISE OPTIMIZATION: Redis O(1) Auth Caching to eliminate MongoDB overhead on high-frequency routes
    if (redis) {
        try {
            const cachedStoreStr = await redis.get(cacheKey);
            if (cachedStoreStr) {
                store = JSON.parse(cachedStoreStr);
            }
        } catch (err) {
            request.log.warn(`Redis auth cache read failed: ${err.message}`);
        }
    }

    if (!store) {
        // Fallback to MongoDB if not cached
        store = await Store.findOne({ 
            'apiIntegration.apiSecretKey': apiKey, 
            isActive: true 
        }).lean(); // Lean for faster memory parsing

        if (!store) {
            throw new AppError('Unauthorized: Invalid or Revoked Enterprise API Key', 403);
        }

        if (redis) {
            try {
                // Cache the verified store for 1 hour to absorb API spam
                await redis.set(cacheKey, JSON.stringify(store), 'EX', 3600);
            } catch (err) {
                request.log.warn(`Redis auth cache write failed: ${err.message}`);
            }
        }
    }

    // Attach the verified store to the request so the controller knows exactly whose data to touch
    request.enterpriseStore = store;
};
