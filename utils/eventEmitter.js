/* utils/eventEmitter.js */
'use strict';

const EventEmitter = require('events');

/**
 * CENTRAL EVENT BUS
 * This allows different parts of the application to communicate without
 * being directly coupled to each other.
 */
class AppEventEmitter extends EventEmitter {}

const appEvents = new AppEventEmitter();

module.exports = appEvents;
