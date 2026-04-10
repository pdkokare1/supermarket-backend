/* utils/cacheUtils.js */
'use strict';

const crypto = require('crypto');

// The client will be injected from app.js to ensure connection sharing.
let redisCache = null;

/**
 * Injects the global Redis client into the cache utility.
 * @param {Object} client - The established Redis client instance.
 */
exports.setClient = (client) => {
    redisCache = client;
};

exports.generateKey = (prefix, queryObj) => {
    let stringifiedData;
    
    if (queryObj && typeof queryObj === 'object') {
        const sortedObj = {};
        Object.keys(queryObj).sort().forEach(key => {
            sortedObj[key] = queryObj[key];
        });
        stringifiedData = JSON.stringify(sortedObj);
    } else {
        stringifiedData = String(queryObj); 
    }
    
    const hash = crypto.createHash('md5').update(stringifiedData).digest('hex');
    return `${prefix}:${hash}`;
};

exports.getCachedData = async (key) => {
    if (!redisCache || !key) return null;
    try {
        const data = await redisCache.get(key);
        return data ? JSON.parse(data) : null;
    } catch (e) {
        console.error("[CACHE UTILS] Get Error:", e.message);
        return null;
    }
};

exports.setCachedData = async (key, data, ttlSeconds = 3600) => {
    if (!redisCache || !key) return;
    try {
        await redisCache.set(key, JSON.stringify(data), 'EX', ttlSeconds);
    } catch (e) {
        console.error("[CACHE UTILS] Set Error:", e.message);
    }
};

exports.deleteKey = async (key) => {
    if (!redisCache || !key) return;
    try {
        await redisCache.del(key);
    } catch (e) {
        console.error("[CACHE UTILS] Delete Error:", e.message);
    }
};

exports.invalidateByPattern = async (pattern) => {
    if (!redisCache || !pattern) return;
    try {
        let cursor = '0';
        do {
            const [newCursor, keys] = await redisCache.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = newCursor;
            if (keys.length > 0) {
                await redisCache.pipeline().del(...keys).exec();
            }
        } while (cursor !== '0');
    } catch(e) {
        console.error(`[CACHE UTILS] Invalidate Error for pattern ${pattern}:`, e.message);
    }
};
