/* services/productCacheService.js */

let redisCache = null;

try {
    const Redis = require('ioredis');
    if (process.env.REDIS_URL) {
        redisCache = new Redis(process.env.REDIS_URL);
    }
} catch (e) {
    console.error("[CACHE SERVICE] Redis Initialization Error:", e.message);
}

const invalidateProductCache = async () => {
    if (redisCache) {
        try {
            let cursor = '0';
            do {
                const [newCursor, keys] = await redisCache.scan(cursor, 'MATCH', 'products:*', 'COUNT', 100);
                cursor = newCursor;
                if (keys.length > 0) {
                    await redisCache.del(...keys);
                }
            } while (cursor !== '0');
        } catch(e) {
            console.error("[CACHE SERVICE] Error invalidating product cache:", e.message);
        }
    }
};

module.exports = {
    redisCache,
    invalidateProductCache
};
