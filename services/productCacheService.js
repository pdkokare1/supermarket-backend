/* services/productCacheService.js */

const cacheUtils = require('../utils/cacheUtils');

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
    // OPTIMIZED: Replaced local loop with centralized cacheUtils utility
    await cacheUtils.invalidateByPattern('products:*');
};

module.exports = {
    redisCache,
    invalidateProductCache
};
