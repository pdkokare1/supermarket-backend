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
    // ENTERPRISE FIX: NX ensures the TTL is strictly set once and cannot be maliciously extended
    if (!ipFails) pipeline.expire(`lockout:ip:${ip}`, 1800, 'NX');
    if (!userFails) pipeline.expire(`lockout:user:${username}`, 900, 'NX');
    await pipeline.exec();
};

// ENTERPRISE OPTIMIZATION: Instant Bot-Trap mechanism
exports.triggerHoneypot = async (ip) => {
    const redis = cacheUtils.getClient();
    if (!redis) return;
    
    // Instantly sets the IP failure count to 9999, effectively banning the bot
    // TTL set to 24 hours (86400 seconds) to block sustained volumetric attacks
    await redis.set(`lockout:ip:${ip}`, 9999, 'EX', 86400);
    console.warn(`[SECURITY] Honeypot triggered. Malicious IP banned: ${ip}`);
};

exports.clearLockout = async (ip, username) => {
    const redis = cacheUtils.getClient();
    if (!redis) return;

    const pipeline = redis.multi(); // FIXED: Called from redis instance
    pipeline.del(`lockout:ip:${ip}`);
    pipeline.del(`lockout:user:${username}`);
    await pipeline.exec();
};
