/* routes/productRoutes.js */

const productController = require('../controllers/productController');
const schemas = require('../schemas/productSchemas');

async function productRoutes(fastify, options) {
    
    // --- Fetch Operations ---
    fastify.get('/api/products', schemas.getProductsSchema, productController.getProducts);

    // --- Core CRUD Operations ---
    fastify.post('/api/products', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.productSchema }, productController.createProduct);
    fastify.put('/api/products/:id', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.productSchema }, productController.updateProduct);
    
    // --- State Operations ---
    fastify.put('/api/products/:id/archive', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, productController.archiveProduct);
    fastify.put('/api/products/:id/toggle', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, productController.toggleProductStatus);

    // --- Inventory Operations ---
    fastify.put('/api/products/:id/restock', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.restockSchema }, productController.restockProduct);
    fastify.put('/api/products/:id/rtv', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...schemas.rtvSchema }, productController.rtvProduct);
    fastify.post('/api/products/transfer', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, productController.transferStock);

    // ============================================================================
    // B2B OMNICHANNEL ROUTES: THE GAMUT FRONTEND INTEGRATION
    // ============================================================================
    
    // Fetch the global catalog to browse available master products
    fastify.get('/api/b2b/catalog', { preHandler: [fastify.authenticate] }, productController.getGlobalCatalog);
    
    // 1-Click Onboard a master product into the tenant's local store
    fastify.post('/api/b2b/onboard', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, productController.addMasterProductToStore);

    // --- NEW: PILLAR B - DISTRIBUTOR WHOLESALE SUBMISSION ---
    fastify.post('/api/b2b/distributor-submit', { preHandler: [fastify.authenticate] }, productController.submitWholesaleItem);

}

// ============================================================================
// --- NEW: PHASE 10 EXPOSE SMART CART UPSELLS ROUTE ---
// ============================================================================
const originalProductRoutesPhase10 = productRoutes;
module.exports = async function(fastify, options) {
    await originalProductRoutesPhase10(fastify, options);
    
    // Expose the zero-cost Heuristic Association Engine to the consumer frontend
    fastify.post('/api/products/smart-upsells', productController.getSmartCartUpsells);
};

// ============================================================================
// --- NEW: PHASE 12 REDIS-BACKED AUTOCOMPLETE CACHE ---
// ============================================================================
const routesExportPhase10 = module.exports;
module.exports = async function(fastify, options) {
    await routesExportPhase10(fastify, options);
    
    // High-Performance Interceptor for Search Queries
    fastify.get('/api/products/autocomplete', async (request, reply) => {
        const query = request.query.q ? request.query.q.toLowerCase() : '';
        if (!query) return reply.send({ success: true, data: [] });
        
        const cacheKey = `autocomplete:${query}`;
        
        if (fastify.redis) {
            try {
                const cachedResult = await fastify.redis.get(cacheKey);
                if (cachedResult) {
                    return reply.code(200).header('X-Cache', 'HIT').send(JSON.parse(cachedResult));
                }
            } catch (e) {
                fastify.log.warn('Redis Cache Error during autocomplete.');
            }
        }
        
        const Product = require('../models/Product');
        const results = await Product.find({
            $or: [
                { name: { $regex: query, $options: 'i' } },
                { searchTags: { $regex: query, $options: 'i' } }
            ],
            status: 'Active'
        }).limit(10).lean();
        
        const response = { success: true, data: results };
        
        if (fastify.redis) {
            try {
                await fastify.redis.set(cacheKey, JSON.stringify(response), 'EX', 3600); // Cache for 1 hour
            } catch (e) {}
        }
        
        return reply.code(200).header('X-Cache', 'MISS').send(response);
    });
};
