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

}

module.exports = productRoutes;
