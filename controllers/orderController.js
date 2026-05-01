/* controllers/orderController.js */
'use strict';

// ============================================================================
// --- ARCHITECTURE UPGRADE: MICRO-CONTROLLER PROXY ---
// This file now serves as a backward-compatibility wrapper. 
// It safely re-exports the separated domains so no legacy imports break.
// ============================================================================

const checkoutController = require('./checkoutController');
const logisticsController = require('./logisticsController');
const supportController = require('./supportController');

module.exports = {
    ...checkoutController,
    ...logisticsController,
    ...supportController
};
