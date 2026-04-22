/* controllers/productController.js */
'use strict';

const inventoryService = require('../services/inventoryService');
const productService = require('../services/productService');
const productCacheService = require('../services/productCacheService');

exports.getProducts = async (request, reply) => {
    
    // DEPRECATION CONSULTATION: Direct DB querying for high-traffic routes overloads MongoDB
    /*
    const productData = await productService.getPaginatedProducts(request.query);
    */

    // OPTIMIZATION: High-Performance Read-Through Catalog Caching with Deterministic Keys
    const sortedQuery = Object.keys(request.query || {}).sort().reduce((result, key) => {
        result[key] = request.query[key];
        return result;
    }, {});
    
    const cacheKey = `products:catalog:${JSON.stringify(sortedQuery)}`;
    const productData = await productCacheService.fetchWithCoalescing(
        cacheKey,
        300, // 5 min TTL
        async () => await productService.getPaginatedProducts(request.query)
    );

    // OPTIMIZATION: Standardized response wrapper.
    return { 
        success: true, 
        message: productData.message || 'Products fetched successfully', 
        count: productData.count,
        total: productData.total,
        data: productData.data 
    };
};

exports.createProduct = async (request, reply) => {
    const newProduct = await productService.createProduct(request.body);
    await productCacheService.invalidateProductCache();
    return { success: true, message: 'Product added', data: newProduct };
};

exports.updateProduct = async (request, reply) => {
    const updatedProduct = await productService.updateProduct(request.params.id, { ...request.body });
    if (!updatedProduct) return reply.status(404).send({ success: false, message: 'Product Not found' });
    
    await productCacheService.invalidateProductCache();
    return { success: true, message: 'Product updated', data: updatedProduct };
};

exports.archiveProduct = async (request, reply) => {
    const product = await productService.archiveProduct(request.params.id);
    if (!product) return reply.status(404).send({ success: false, message: 'Product Not found' });
    
    await productCacheService.invalidateProductCache();
    return { success: true, message: `Product archived securely`, data: product };
};

exports.toggleProductStatus = async (request, reply) => {
    const product = await productService.toggleProductStatus(request.params.id);
    if (!product) return reply.status(404).send({ success: false, message: 'Product Not found' });
    
    await productCacheService.invalidateProductCache();
    return { success: true, message: `Product Status Toggled`, data: product };
};

exports.restockProduct = async (request, reply) => {
    const product = await inventoryService.processRestock(request.params.id, request.body);
    return { success: true, message: 'Restock processed successfully', data: product };
};

exports.rtvProduct = async (request, reply) => {
    const product = await inventoryService.processRTV(request.params.id, request.body);
    return { success: true, message: 'RTV processed successfully', data: product };
};

exports.transferStock = async (request, reply) => {
    const username = request.user ? request.user.username : 'Admin';
    await inventoryService.processTransfer(request.body, username, request.server.log.error.bind(request.server.log));
    return { success: true, message: 'Stock transferred successfully.' };
};
