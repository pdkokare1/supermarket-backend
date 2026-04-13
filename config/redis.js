/* config/redis.js */
const Redis = require('ioredis');

const initRedis = () => {
    let redisClient = null;
    try {
        if (process.env.REDIS_URL) {
            // OPTIMIZATION: Added retry strategy and event listeners for connection resilience and observability
            redisClient = new Redis(process.env.REDIS_URL, {
                retryStrategy(times) {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                },
                maxRetriesPerRequest: 3 // Prevent infinite hanging if Redis goes down
            });

            redisClient.on('connect', () => console.log('[SERVER] Redis connected successfully.'));
            redisClient.on('error', (err) => console.warn('[SERVER] Redis Error:', err.message));
        }
    } catch(e) {
        console.warn('[SERVER] Redis initialization failed:', e.message);
    }
    return redisClient;
};

module.exports = initRedis;
