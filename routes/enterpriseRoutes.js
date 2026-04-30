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

    // --- NEW: B2B PROCUREMENT AUTOMATION ---
    // Shop instantly drafts a PO dynamically routed to the cheapest local distributor
    fastify.post('/api/enterprise/procurement/create-po', async (request, reply) => {
        return await enterpriseController.createB2BPurchaseOrder(request, reply);
    });

    // --- NEW: ENTERPRISE STORE-IN-STORE API (MEGA-CHAINS) ---
    // Dedicated endpoint for ERPs (like Reliance/Croma) to post bulk JSON payloads.
    fastify.post('/api/enterprise/sync-inventory', async (request, reply) => {
        return await enterpriseController.syncStoreInventory(request, reply);
    });

    // --- NEW: PHASE 1 ENTERPRISE ORDER FETCH ---
    // Allow ERPs to pull their store's orders programmatically
    fastify.get('/api/enterprise/orders', async (request, reply) => {
        return await enterpriseController.fetchOrders(request, reply);
    });
};

// ============================================================================
// --- NEW: PHASE 15 DEAD LETTER QUEUE (DLQ) HQ ROUTES ---
// ============================================================================
const originalEnterpriseRoutes = module.exports;

module.exports = async function (fastify, opts) {
    // 1. Register all original legacy routes securely
    await originalEnterpriseRoutes(fastify, opts);

    // 2. Safely inject the new DLQ monitoring routes
    fastify.get('/api/enterprise/webhooks/failed', { 
        preHandler: [fastify.authenticate, fastify.verifySuperAdmin] 
    }, async (request, reply) => {
        try {
            const webhookService = require('../services/webhookService');
            const failedLogs = await webhookService.getFailedWebhooks();
            
            if (!failedLogs || failedLogs.length === 0) {
                return reply.code(404).send({ success: false, message: 'System Healthy. No failed webhooks detected.' });
            }
            return reply.send({ success: true, data: failedLogs });
        } catch (e) {
            fastify.log.error('Failed to fetch DLQ:', e);
            return reply.code(500).send({ success: false, message: 'Server error' });
        }
    });

    fastify.post('/api/enterprise/webhooks/retry/:id', {
        preHandler: [fastify.authenticate, fastify.verifySuperAdmin]
    }, async (request, reply) => {
        try {
            const webhookService = require('../services/webhookService');
            const result = await webhookService.retryFailedWebhook(request.params.id);
            if (result.success) {
                return reply.send({ success: true, message: 'Webhook retry successful!' });
            } else {
                return reply.code(400).send({ success: false, message: result.message });
            }
        } catch (e) {
            fastify.log.error('Webhook retry failed:', e);
            return reply.code(500).send({ success: false, message: 'Server error' });
        }
    });
};
