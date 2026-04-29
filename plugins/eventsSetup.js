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

    // ============================================================================
    // --- NEW: PHASE 3 OUTBOUND ENTERPRISE WEBHOOK ENGINE ---
    // ============================================================================
    // Acts as a non-blocking secondary listener to prevent impacting core checkout speed.
    appEvents.on('NEW_ORDER', async (payload) => {
        const { order, storeId } = payload;
        
        setImmediate(async () => {
            try {
                // Dynamically required to avoid circular dependencies on boot
                const Store = require('../models/Store');
                const axios = require('axios');
                
                const store = await Store.findById(storeId);
                
                // If it's a Mega-Chain, push the order directly to their native ERP system
                if (store && store.storeType === 'ENTERPRISE' && store.apiIntegration && store.apiIntegration.webhookUrl) {
                    await axios.post(store.apiIntegration.webhookUrl, {
                        event: 'order.created',
                        timestamp: new Date(),
                        data: order
                    }, {
                        headers: { 
                            'Authorization': `Bearer ${store.apiIntegration.apiSecretKey}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 5000 // 5-second fail-safe so we don't hold up backend memory
                    });
                }
            } catch (err) {
                console.error(`[ENTERPRISE WEBHOOK FAILED] Store: ${storeId}, Order: ${order._id}. Error:`, err.message);
            }
        });
    });
};
