/* routes/settlementRoutes.js */
'use strict';

const settlementController = require('../controllers/settlementController');

async function settlementRoutes(fastify, options) {
    // Route 1: Get all pending payouts
    fastify.get('/api/settlements/global', { preHandler: [fastify.authenticate] }, settlementController.getGlobalSettlements);

    // Route 2: Get all active disputes
    fastify.get('/api/settlements/disputes', { preHandler: [fastify.authenticate] }, settlementController.getDisputes);

    // Route 3: Process a payout to a partner
    fastify.post('/api/settlements/:id/process', { preHandler: [fastify.authenticate] }, settlementController.processSettlement);

    // Route 4: Resolve a disputed return
    fastify.post('/api/settlements/:id/resolve', { preHandler: [fastify.authenticate] }, settlementController.resolveDispute);

    // --- NEW: PHASE 3 OMNI-CART CLEARING ---
    // Calculates platform fees and routes Rs to D-Mart, Croma, etc. ledgers
    fastify.post('/api/settlements/omni-clearing', { preHandler: [fastify.authenticate] }, settlementController.triggerOmniCartClearing);
}

module.exports = settlementRoutes;
