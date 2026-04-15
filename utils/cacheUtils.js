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

/**
 * Retrieves the global Redis client.
 * @returns {Object|null} The Redis client instance or null.
 */
exports.getClient = () => {
    return redisCache;
};

exports.generateKey = (prefix, queryObj) => {
    let stringifiedData;
    
    if (queryObj && typeof queryObj === 'object') {
        // OPTIMIZATION: Native replacer array handles deterministic stringification faster than an intermediate object loop
        stringifiedData = JSON.stringify(queryObj, Object.keys(queryObj).sort());
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
        const stringified = JSON.stringify(data);
        
        // OPTIMIZATION: Memory Protection. Do not cache payloads larger than ~500KB to prevent Redis OOM errors on cheap tiers.
        if (Buffer.byteLength(stringified, 'utf8') > 500000) {
            console.warn(`[CACHE UTILS] Payload too large for key ${key}. Bypassing Redis cache to protect memory.`);
            return;
        }

        await redisCache.set(key, stringified, 'EX', ttlSeconds);
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
