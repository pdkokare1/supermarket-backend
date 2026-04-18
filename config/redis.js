/* config/redis.js */
'use strict';

const Redis = require('ioredis');

const initRedis = () => {
    if (!process.env.REDIS_URL) {
        console.warn('REDIS_URL not provided. Running without Redis cache.');
        return null;
    }

    try {
        const redisClient = new Redis(process.env.REDIS_URL, {
            // FIX: Disables the infinite waiting room. If Redis is down, fail instantly.
            enableOfflineQueue: false,
            // FIX: Forces any hanging commands to abort after 2 seconds instead of 10.
            commandTimeout: 2000,
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                // Exponential backoff for reconnections to prevent spamming the network
                return Math.min(times * 100, 3000);
            }
        });

        redisClient.on('error', (err) => {
            console.error('[REDIS] Connection Error:', err.message);
        });

        redisClient.on('ready', () => {
            console.log('[REDIS] Client successfully connected and ready to receive commands.');
        });

        return redisClient;
    } catch (error) {
        console.error('Failed to initialize Redis:', error);
        return null;
    }
};

module.exports = initRedis;
