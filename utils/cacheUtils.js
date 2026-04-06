/* utils/cacheUtils.js */

const crypto = require('crypto');

let redisCache = null;

try {
    const Redis = require('ioredis');
    if (process.env.REDIS_URL) {
        redisCache = new Redis(process.env.REDIS_URL);
        
        redisCache.on('error', (err) => {
            console.error("[CACHE UTILS] Redis Error:", err.message);
        });
        
        redisCache.on('connect', () => {
            console.log("[CACHE UTILS] Successfully connected to Redis");
        });
    }
} catch (e) {
    console.error("[CACHE UTILS] Redis Initialization Error:", e.message);
}

exports.redisCache = redisCache;

exports.generateKey = (prefix, queryObj) => {
    let stringifiedData;
    
    // OPTIMIZATION: CPU Cycle saving. Bypasses JSON.stringify entirely for primitive types.
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
                // OPTIMIZATION: Implemented Redis Pipeline to batch deletes
                await redisCache.pipeline().del(...keys).exec();
            }
        } while (cursor !== '0');
    } catch(e) {
        console.error(`[CACHE UTILS] Invalidate Error for pattern ${pattern}:`, e.message);
    }
};
