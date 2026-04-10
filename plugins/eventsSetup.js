/* plugins/eventsSetup.js */
'use strict';

const appEvents = require('../utils/eventEmitter');
const sseService = require('../services/orderSseService');

module.exports = function(fastify) {
    
    // --- INVENTORY EVENTS ---
    appEvents.on('PRODUCT_UPDATED', (payload) => {
        fastify.log.info(`Broadcasting product update for ID: ${payload.productId}`);
        fastify.broadcastToPOS({ 
            type: 'INVENTORY_UPDATED', 
            productId: payload.productId,
            message: payload.message || 'Product updated',
            storeId: payload.storeId
        });
    });

    // --- ORDER EVENTS ---

    // Handles New Orders (POS, Online, External)
    appEvents.on('NEW_ORDER', (payload) => {
        const { order, storeId, source } = payload;
        
        // Notify SSE clients (Admin/Customer Dashboard)
        sseService.notifyNewOrder({ server: fastify }, order, storeId, source);

        // Notify WebSocket clients (POS terminals)
        if (source === 'POS') {
            fastify.broadcastToPOS({ type: 'NEW_ORDER', orderId: order._id, source: 'POS', storeId: storeId });
        }
    });

    // Handles Status Changes (Cancelled, Dispatched, Packing, etc.)
    appEvents.on('ORDER_STATUS_UPDATED', (payload) => {
        const { orderId, status, storeId } = payload;
        sseService.notifyStatusUpdate({ server: fastify }, orderId, status, storeId);
    });

    // Handles General Order Modifications (Driver assignment, items updated)
    appEvents.on('ORDER_UPDATED', (payload) => {
        fastify.broadcastToPOS({ type: 'ORDER_UPDATED', orderId: payload.orderId, storeId: payload.storeId });
    });

    // Handles Refunds
    appEvents.on('ORDER_REFUNDED', (payload) => {
        fastify.broadcastToPOS({ type: 'ORDER_REFUNDED', orderId: payload.orderId, storeId: payload.storeId });
    });

};
