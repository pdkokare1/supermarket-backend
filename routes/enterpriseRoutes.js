/* routes/enterpriseRoutes.js */
'use strict';

const enterpriseController = require('../controllers/enterpriseController');

module.exports = async function (fastify, opts) {
    // NOTE: These routes use a custom API Key header (x-enterprise-api-key) 
    // instead of standard JWT user authentication, allowing ERP systems to hit them directly.

    // Endpoint for partners to update delivery status
    fastify.post('/webhooks/fulfillment', async (request, reply) => {
        return await enterpriseController.updateFulfillmentStatus(request, reply);
    });

    // Endpoint for partners to push massive stock/price updates
    fastify.post('/webhooks/inventory-sync', async (request, reply) => {
        return await enterpriseController.batchUpdateInventory(request, reply);
    });
};
