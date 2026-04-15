/* services/productCacheService.js */

const cacheUtils = require('../utils/cacheUtils');

// OPTIMIZATION: Addressed a connection leak. Bypassing local variable declaration.
// We will dynamically fetch the shared client from cacheUtils to prevent database limits.
/* let redisCache = null; */

// OPTIMIZATION: In-memory promise map to mitigate Cache Stampedes / Thundering Herds
const inFlightPromises = new Map();

// DEPRECATION CONSULTATION: Initializing a new Redis client here causes severe connection leaks 
// because it bypasses the global pool established in app.js. The logic has been commented out.
/*
try {
    const Redis = require('ioredis');
    if (process.env.REDIS_URL) {
        redisCache = new Redis(process.env.REDIS_URL);
    }
} catch (e) {
    console.error("[CACHE SERVICE] Redis Initialization Error:", e.message);
}
*/

// OPTIMIZATION: Promise Coalescing Wrapper. Use this in your controllers to safely fetch cacheable data.
const fetchWithCoalescing = async (cacheKey, ttlSeconds, dbFetchFunction) => {
    // 1. Check Redis Cache
    const cachedData = await cacheUtils.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    // 2. Cache Miss: Check if another concurrent request is already querying the database
    if (inFlightPromises.has(cacheKey)) {
        return inFlightPromises.get(cacheKey); // Wait for the active DB query to finish
    }

    // 3. First request: Create a new promise, store it globally, and query the DB
    const fetchPromise = (async () => {
        try {
            const freshData = await dbFetchFunction();
            await cacheUtils.setCachedData(cacheKey, freshData, ttlSeconds);
            return freshData;
        } finally {
            inFlightPromises.delete(cacheKey); // Always cleanup the lock to prevent memory leaks
        }
    })();

    inFlightPromises.set(cacheKey, fetchPromise);
    return fetchPromise;
};

const invalidateProductCache = async () => {
    await cacheUtils.invalidateByPattern('products:*');
};

module.exports = {
    // Expose the dynamically fetched global cache client instead of the leaked local instance
    get redisCache() { return cacheUtils.getClient(); },
    invalidateProductCache,
    fetchWithCoalescing
};
