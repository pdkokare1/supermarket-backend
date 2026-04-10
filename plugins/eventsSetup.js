/* plugins/eventsSetup.js */
'use strict';

const appEvents = require('../utils/eventEmitter');
const sseService = require('../services/orderSseService');

module.exports = function(fastify) {
    
    // --- INVENTORY EVENTS ---
    appEvents.on('PRODUCT_UPDATED', (payload) => {
        fastify.broadcastToPOS({ 
            type: 'INVENTORY_UPDATED', 
            productId: payload.productId,
            message: payload.message || 'Product updated',
            storeId: payload.storeId
        });
    });

    // --- ORDER EVENTS ---
    appEvents.on('NEW_ORDER', (payload) => {
        const { order, storeId, source } = payload;
        sseService.notifyNewOrder({ server: fastify }, order, storeId, source);
        if (source === 'POS') {
            fastify.broadcastToPOS({ type: 'NEW_ORDER', orderId: order._id, source: 'POS', storeId: storeId });
        }
    });

    appEvents.on('ORDER_STATUS_UPDATED', (payload) => {
        sseService.notifyStatusUpdate({ server: fastify }, payload.orderId, payload.status, payload.storeId);
    });

    appEvents.on('ORDER_UPDATED', (payload) => {
        fastify.broadcastToPOS({ type: 'ORDER_UPDATED', orderId: payload.orderId, storeId: payload.storeId });
    });

    appEvents.on('ORDER_REFUNDED', (payload) => {
        fastify.broadcastToPOS({ type: 'ORDER_REFUNDED', orderId: payload.orderId, storeId: payload.storeId });
    });

    // --- CUSTOMER EVENTS ---
    appEvents.on('CUSTOMER_UPDATED', (payload) => {
        fastify.broadcastToPOS({ type: 'CUSTOMER_UPDATED', phone: payload.phone });
    });

    appEvents.on('CUSTOMER_PAYMENT_RECORDED', (payload) => {
        fastify.broadcastToPOS({ type: 'CUSTOMER_PAYMENT_RECORDED', phone: payload.phone });
    });

    // --- PROMOTION EVENTS ---
    appEvents.on('PROMOTION_ADDED', (payload) => {
        fastify.broadcastToPOS({ type: 'PROMOTION_ADDED', promotionId: payload.promotionId });
    });

    appEvents.on('PROMOTION_TOGGLED', (payload) => {
        fastify.broadcastToPOS({ 
            type: 'PROMOTION_TOGGLED', 
            promotionId: payload.promotionId, 
            isActive: payload.isActive 
        });
    });

    // --- STAFF EVENTS ---
    appEvents.on('STAFF_CREATED', (payload) => {
        fastify.broadcastToPOS({ type: 'STAFF_CREATED', username: payload.username });
    });

    // --- EXPENSE EVENTS ---
    appEvents.on('EXPENSE_LOGGED', (payload) => {
        fastify.broadcastToPOS({ type: 'EXPENSE_LOGGED', amount: payload.amount });
    });

    // --- DISTRIBUTOR EVENTS ---
    appEvents.on('DISTRIBUTOR_ADDED', (payload) => {
        fastify.broadcastToPOS({ type: 'DISTRIBUTOR_ADDED', distributorId: payload.distributorId });
    });

    appEvents.on('DISTRIBUTOR_UPDATED', (payload) => {
        fastify.broadcastToPOS({ type: 'DISTRIBUTOR_UPDATED', distributorId: payload.distributorId });
    });
};
