/* routes/enterpriseRoutes.js */
'use strict';

const enterpriseController = require('../controllers/enterpriseController');
const productController = require('../controllers/productController');

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

    // ============================================================================
    // ENTERPRISE B2B ROUTES: ERP SYSTEM INTEGRATION
    // ============================================================================

    // Allow ERPs to pull the global master catalog to map their internal SKUs
    fastify.get('/api/enterprise/catalog', async (request, reply) => {
        return await productController.getGlobalCatalog(request, reply);
    });

    // Allow ERPs to programmatically map and onboard a product to their specific store
    fastify.post('/api/enterprise/onboard', async (request, reply) => {
        return await productController.addMasterProductToStore(request, reply);
    });

    // --- NEW: PHASE 2 ENTERPRISE UPSERT ROUTE ---
    // Push array of SKUs to dynamically upsert against the Master Catalog
    fastify.post('/api/enterprise/inventory/upsert', async (request, reply) => {
        return await enterpriseController.upsertCatalogAndInventory(request, reply);
    });
};
