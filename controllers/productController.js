/* controllers/productController.js */
'use strict';

const inventoryService = require('../services/inventoryService');
const productService = require('../services/productService');
const productCacheService = require('../services/productCacheService');

exports.getProducts = async (request, reply) => {
    // ENFORCING TENANT BOUNDARY: Auto-inject storeId so users only see their store's inventory
    const queryPayload = { ...request.query };
    if (request.user && request.user.tenantId) {
        queryPayload.storeId = request.user.tenantId;
    }

    const sortedQuery = Object.keys(queryPayload).sort().reduce((result, key) => {
        result[key] = queryPayload[key];
        return result;
    }, {});
    
    const cacheKey = `products:catalog:${JSON.stringify(sortedQuery)}`;
    const productData = await productCacheService.fetchWithCoalescing(
        cacheKey,
        300, 
        async () => await productService.getPaginatedProducts(queryPayload)
    );

    return { 
        success: true, 
        message: productData.message || 'Products fetched successfully', 
        count: productData.count,
        total: productData.total,
        data: productData.data 
    };
};

exports.createProduct = async (request, reply) => {
    // ENFORCING TENANT BOUNDARY
    const payload = { ...request.body };
    if (request.user && request.user.tenantId) {
        payload.storeId = request.user.tenantId;
    }

    const newProduct = await productService.createProduct(payload);
    await productCacheService.invalidateProductCache();
    return { success: true, message: 'Product added', data: newProduct };
};

exports.updateProduct = async (request, reply) => {
    const payload = { ...request.body };
    if (request.user && request.user.tenantId) {
        payload.storeId = request.user.tenantId;
    }

    const updatedProduct = await productService.updateProduct(request.params.id, payload);
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
    const payload = { ...request.body };
    if (request.user && request.user.tenantId) {
        payload.storeId = request.user.tenantId;
    }

    const product = await inventoryService.processRestock(request.params.id, payload);
    return { success: true, message: 'Restock processed successfully', data: product };
};

exports.rtvProduct = async (request, reply) => {
    const payload = { ...request.body };
    if (request.user && request.user.tenantId) {
        payload.storeId = request.user.tenantId;
    }

    const product = await inventoryService.processRTV(request.params.id, payload);
    return { success: true, message: 'RTV processed successfully', data: product };
};

exports.transferStock = async (request, reply) => {
    const username = request.user ? request.user.username : 'Admin';
    await inventoryService.processTransfer(request.body, username, request.server.log.error.bind(request.server.log));
    return { success: true, message: 'Stock transferred successfully.' };
};
