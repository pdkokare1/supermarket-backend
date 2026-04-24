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

// ENTERPRISE FIX: Recursive Deterministic Stringifier
// Resolves severe cache collisions where nested object structures were corrupted/ignored by standard JSON.stringify replacers.
const stringifyDeterministic = (obj) => {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(stringifyDeterministic).join(',')}]`;
    
    const keys = Object.keys(obj).sort();
    let result = '{';
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        result += `"${key}":${stringifyDeterministic(obj[key])}`;
        if (i < keys.length - 1) result += ',';
    }
    return result + '}';
};

exports.generateKey = (prefix, queryObj) => {
    const stringifiedData = typeof queryObj === 'object' ? stringifyDeterministic(queryObj) : String(queryObj); 
    
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

    // OPTIMIZATION: Pre-serialization heuristic. We reject massive arrays upfront before wasting CPU cycles locking the thread.
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
                // ENTERPRISE FIX: Safe chunking to prevent "Maximum call stack size exceeded" V8 engine crashes
                const CHUNK_SIZE = 500;
                for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
                    const chunk = keys.slice(i, i + CHUNK_SIZE);
                    await redisCache.pipeline().unlink(...chunk).exec();
                }
            }
        } while (cursor !== '0');
    } catch(e) {
        console.error(`[CACHE UTILS] Invalidate Error for pattern ${pattern}:`, e.message);
    }
};
