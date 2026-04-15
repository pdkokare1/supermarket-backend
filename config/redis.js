/* config/redis.js */
'use strict';

const Redis = require('ioredis');

// OPTIMIZATION: Accept fastify instance to enforce structured logging
const initRedis = (fastify = null) => {
    let redisClient = null;
    const logger = fastify && fastify.log ? fastify.log : console;

    try {
        if (process.env.REDIS_URL) {
            redisClient = new Redis(process.env.REDIS_URL, {
                retryStrategy(times) {
                    // OPTIMIZATION: Exponential backoff with Jitter for enterprise cloud resilience
                    const delay = Math.min(times * 100, 3000); 
                    const jitter = Math.floor(Math.random() * 200); 
                    return delay + jitter;
                },
                maxRetriesPerRequest: 3, // Prevent infinite hanging if Redis goes down
                
                // OPTIMIZATION: Fail-fast offline queue. Prevents API requests from hanging 
                enableOfflineQueue: false,
                
                // OPTIMIZATION: Keep-Alive pings prevent Railway/Cloud proxies from dropping idle TCP connections
                keepAlive: 10000 
            });

            redisClient.on('connect', () => logger.info('[SERVER] Redis connected successfully.'));
            redisClient.on('error', (err) => logger.error(`[SERVER] Redis Error: ${err.message}`));
        } else {
            logger.warn('[SERVER] REDIS_URL not provided. Redis client bypassed.');
        }
    } catch(e) {
        logger.error(`[SERVER] Redis initialization failed: ${e.message}`);
    }
    
    return redisClient;
};

module.exports = initRedis;
