/* utils/eventEmitter.js */
'use strict';

const EventEmitter = require('events');
const cacheUtils = require('./cacheUtils');

/**
 * CENTRAL EVENT BUS
 * This allows different parts of the application to communicate without
 * being directly coupled to each other.
 */
class AppEventEmitter extends EventEmitter {
    constructor() {
        super();
        // OPTIMIZATION: Initialization of micro-batching queue to drastically reduce Redis I/O overhead
        this.batchQueue = [];
        this.batchTimeout = null;
    }

    // OPTIMIZATION: Centralized method to publish across horizontal instances via Redis Pub/Sub
    broadcastEvent(eventName, payload) {
        // Wrapped in setImmediate to completely decouple from the main synchronous execution thread
        setImmediate(() => {
            // Retain native Node emitter for single-instance listeners
            this.emit(eventName, payload);
            
            // ENTERPRISE OPTIMIZATION: High-Throughput Event Micro-Batching
            this.batchQueue.push({ eventName, payload });
            
            if (!this.batchTimeout) {
                this.batchTimeout = setTimeout(() => {
                    const redis = cacheUtils.getClient();
                    if (redis && this.batchQueue.length > 0) {
                        // Flushes multiple rapid events as a single network payload
                        redis.publish('DAILYPICK_ORDER_EVENTS', JSON.stringify(this.batchQueue)).catch(() => {});
                    }
                    this.batchQueue = [];
                    this.batchTimeout = null;
                }, 50); // 50ms flush window consolidates bursts of operations
            }
        });
    }
}

const appEvents = new AppEventEmitter();

module.exports = appEvents;
