/* jobs/inventoryHandler.js */

exports.handleInventoryReport = async (redisClient, fastify, newReport) => {
    if (redisClient) {
        try {
            await redisClient.set('cache:inventory:report', JSON.stringify(newReport), 'EX', 86400); // 24h cache
        } catch(e) {
            fastify.log.error('Failed to update inventory report in Redis:', e);
        }
    }
};
