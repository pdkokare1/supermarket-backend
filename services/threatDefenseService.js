/* services/threatDefenseService.js */
'use strict';
const cacheUtils = require('../utils/cacheUtils');

exports.checkLockoutStatus = async (ip, username) => {
    const redis = cacheUtils.getClient();
    if (!redis) return { ipFails: 0, userFails: 0 };

    const ipFails = await redis.get(`lockout:ip:${ip}`);
    const userFails = await redis.get(`lockout:user:${username}`);

    if (ipFails && parseInt(ipFails) > 10) throw new Error('IP_BLOCKED');
    if (userFails && parseInt(userFails) > 10) throw new Error('USER_BLOCKED');

    return { ipFails, userFails };
};

exports.recordFailedAttempt = async (ip, username, ipFails, userFails) => {
    const redis = cacheUtils.getClient();
    if (!redis) return;

    const pipeline = redis.multi();
    pipeline.incr(`lockout:ip:${ip}`);
    pipeline.incr(`lockout:user:${username}`);
    if (!ipFails) pipeline.expire(`lockout:ip:${ip}`, 1800);
    if (!userFails) pipeline.expire(`lockout:user:${username}`, 900);
    await pipeline.exec();
};

exports.clearLockout = async (ip, username) => {
    const redis = cacheUtils.getClient();
    if (!redis) return;

    const pipeline = redis.multi();
    pipeline.del(`lockout:ip:${ip}`);
    pipeline.del(`lockout:user:${username}`);
    await pipeline.exec();
};
