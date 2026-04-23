/* config/redis.js */
'use strict';

const Redis = require('ioredis');

const initRedis = () => {
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

        // Error handlers must remain attached to prevent unhandled promise rejections,
        // but we remove synchronous console output to prevent blocking the event loop.
        redisClient.on('error', () => {});
        redisClient.on('ready', () => {});

        return redisClient;
    } catch (error) {
        return null;
    }
};

module.exports = initRedis;
