/* plugins/loadSheddingSetup.js */
'use strict';

const fp = require('fastify-plugin');

module.exports = fp(async (fastify, opts) => {
    // ENTERPRISE STABILITY: Load Shedding. Prevents Event Loop collapse under DDoS/heavy traffic.
    fastify.register(require('@fastify/under-pressure'), {
        maxEventLoopDelay: process.env.MAX_EVENT_LOOP_DELAY || 1000,
        maxHeapUsedBytes: process.env.MAX_HEAP_BYTES || 1000000000, // 1GB
        maxRssBytes: process.env.MAX_RSS_BYTES || 1000000000,
        maxEventLoopUtilization: process.env.MAX_EVENT_LOOP_UTIL || 0.98,
        message: 'Service Unavailable: DailyPick server is under heavy load. Please try again later.',
        retryAfter: process.env.RETRY_AFTER || 50
    });
});
