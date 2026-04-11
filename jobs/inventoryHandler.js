/* jobs/inventoryHandler.js */

const cacheUtils = require('../utils/cacheUtils');

exports.handleInventoryReport = async (redisClient, fastify, newReport) => {
    // OPTIMIZED: Replaced raw redis call with centralized cacheUtils
    await cacheUtils.setCachedData('cache:inventory:report', newReport, 86400); 
};
