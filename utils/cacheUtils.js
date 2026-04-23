/* utils/cacheUtils.js */
'use strict';

const crypto = require('crypto');

let redisCache = null;

exports.setClient = (client) => {
    redisCache = client;
};

exports.getClient = () => {
    return redisCache;
};

exports.generateKey = (prefix, queryObj) => {
    let stringifiedData;
    
    if (queryObj && typeof queryObj === 'object') {
        stringifiedData = JSON.stringify(queryObj, Object.keys(queryObj).sort());
    } else {
        stringifiedData = String(queryObj); 
    }
    
    // OPTIMIZATION: Upgraded from MD5 to SHA-256. Hardware accelerated on modern CPUs, faster and prevents collision attacks.
    const hash = crypto.createHash('sha256').update(stringifiedData).digest('hex');
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

    // OPTIMIZATION: Pre-serialization heuristic. Stringifying massive JSON blocks the Node event loop synchronously.
    // We reject massive arrays upfront before wasting CPU cycles locking the thread.
    if (Array.isArray(data) && data.length > 5000) {
        console.warn(`[CACHE UTILS] Payload exceeds safe array length for key ${key}. Bypassing cache to protect Event Loop.`);
        return;
    }

    try {
        const stringified = JSON.stringify(data);
        
        if (stringified.length > 500000) {
            console.warn(`[CACHE UTILS] Payload too large (${stringified.length} bytes) for key ${key}. Bypassing Redis cache to protect memory.`);
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
                await redisCache.pipeline().unlink(...keys).exec();
            }
        } while (cursor !== '0');
    } catch(e) {
        console.error(`[CACHE UTILS] Invalidate Error for pattern ${pattern}:`, e.message);
    }
};
