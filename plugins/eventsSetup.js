/* plugins/eventsSetup.js */
'use strict';

const appEvents = require('../utils/eventEmitter');

module.exports = function(fastify) {
    /**
     * When any service emits 'PRODUCT_UPDATED', this listener 
     * broadcasts the change to all connected POS clients.
     */
    appEvents.on('PRODUCT_UPDATED', (payload) => {
        fastify.log.info(`Broadcasting product update for ID: ${payload.productId}`);
        fastify.broadcastToPOS({ 
            type: 'INVENTORY_UPDATED', 
            productId: payload.productId,
            message: payload.message || 'Product updated'
        });
    });
};
