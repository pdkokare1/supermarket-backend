/* routes/webhookRoutes.js */
'use strict';

const webhookController = require('../controllers/webhookController');
const { verifyEnterpriseKey } = require('../middlewares/enterpriseAuth');

async function webhookRoutes(fastify, options) {
    
    // --- FINANCIAL WEBHOOKS (Public, but cryptographically secured) ---
    // Fastify needs access to the raw body to verify the Razorpay signature.
    fastify.post('/api/webhooks/razorpay', { config: { rawBody: true } }, webhookController.razorpayWebhook);

    // --- LOGISTICS WEBHOOKS (Public, but token-secured in production) ---
    fastify.post('/api/webhooks/logistics', webhookController.logisticsWebhook);

    // --- ENTERPRISE B2B ROUTES (Secured by Developer Portal Keys) ---
    // Example: A route for a partner supermarket to push their Tally/ERP inventory to The Gamut
    fastify.post('/api/enterprise/sync/inventory', { preHandler: [verifyEnterpriseKey] }, async (request, reply) => {
        const store = request.enterpriseStore;
        
        // In a full implementation, you would pass request.body to an inventoryService
        // For now, we acknowledge the secure connection.
        request.server.log.info(`Enterprise Sync: Received inventory push from Store ${store._id} (${store.name})`);
        
        return reply.code(200).send({ 
            success: true, 
            message: `Inventory sync acknowledged for ${store.name}`,
            storeId: store._id
        });
    });

}

module.exports = webhookRoutes;
