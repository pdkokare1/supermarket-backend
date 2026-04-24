/* config/redis.js */
'use strict';

const Redis = require('ioredis');

const initRedis = (logger = console) => {
    if (!process.env.REDIS_URL) {
        return null;
    }

    try {
        const redisClient = new Redis(process.env.REDIS_URL, {
            enableOfflineQueue: false,
            commandTimeout: 2000,
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                return Math.min(times * 100, 3000);
            }
        });

        // Enterprise Observability: Handle errors gracefully without crashing, 
        // while ensuring metrics are visible to the system logger.
        redisClient.on('error', (err) => logger.error(`Redis Client Error: ${err.message}`));
        redisClient.on('connect', () => logger.info('Redis Client successfully connected'));
        redisClient.on('reconnecting', () => logger.warn('Redis Client is reconnecting to the server'));

        return redisClient;
    } catch (error) {
        logger.error(`Failed to initialize Redis client: ${error.message}`);
        return null;
    }
};

module.exports = initRedis;
