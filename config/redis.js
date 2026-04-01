/* config/redis.js */
const Redis = require('ioredis');

const initRedis = () => {
    let redisClient = null;
    try {
        if (process.env.REDIS_URL) {
            redisClient = new Redis(process.env.REDIS_URL);
        }
    } catch(e) {
        console.warn('[SERVER] Redis initialization failed:', e.message);
    }
    return redisClient;
};

module.exports = initRedis;
