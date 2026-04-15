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
    // OPTIMIZATION: Centralized method to publish across horizontal instances via Redis Pub/Sub
    broadcastEvent(eventName, payload) {
        // Wrapped in setImmediate to completely decouple from the main synchronous execution thread
        setImmediate(() => {
            // Retain native Node emitter for single-instance listeners
            this.emit(eventName, payload);
            
            // Broadcast to other Railway instances via Redis
            const redis = cacheUtils.getClient();
            if (redis) {
                redis.publish('DAILYPICK_ORDER_EVENTS', JSON.stringify({ eventName, payload })).catch(() => {});
            }
        });
    }
}

const appEvents = new AppEventEmitter();

module.exports = appEvents;
