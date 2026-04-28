/* controllers/productController.js */
'use strict';

const inventoryService = require('../services/inventoryService');
const productService = require('../services/productService');
const productCacheService = require('../services/productCacheService');

// --- NEW IMPORTS FOR B2B OMNICHANNEL (THE GAMUT) ---
const MasterProduct = require('../models/MasterProduct');
const StoreInventory = require('../models/StoreInventory');

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

// ============================================================================
// NEW B2B OMNICHANNEL FUNCTIONS: THE DAILYPICK MASTER CATALOG INTEGRATION
// ============================================================================

exports.getGlobalCatalog = async (request, reply) => {
    // Allows onboarded stores to search the master database so they don't have to create products manually
    const queryPayload = { ...request.query };
    
    const limit = parseInt(queryPayload.limit) || 20;
    const page = parseInt(queryPayload.page) || 1;
    const skip = (page - 1) * limit;

    let query = { isActive: true };
    
    // Enterprise Text Search against the indexes in MasterProduct.js
    if (queryPayload.search) {
        query.$text = { $search: queryPayload.search };
    }
    if (queryPayload.category) {
        query.category = queryPayload.category;
    }

    const masterProducts = await MasterProduct.find(query).skip(skip).limit(limit).lean();
    const total = await MasterProduct.countDocuments(query);

    return { 
        success: true, 
        message: 'Global catalog fetched successfully', 
        count: masterProducts.length,
        total: total,
        data: masterProducts 
    };
};

exports.addMasterProductToStore = async (request, reply) => {
    // 1-Click B2B Onboarding: Copies a Master Product into a Store's local inventory
    const { masterProductId, variantId, sellingPrice, stock, lowStockThreshold } = request.body;
    
    // Fallback to payload storeId if tenantId isn't on the request (e.g., Enterprise API sync)
    const storeId = request.user && request.user.tenantId ? request.user.tenantId : request.body.storeId;

    if (!storeId) {
        return reply.status(400).send({ success: false, message: 'Store ID is required for catalog bridging' });
    }

    // Guard Clause: Prevent duplicate onboarding
    const existingInventory = await StoreInventory.findOne({ storeId, masterProductId, variantId });
    if (existingInventory) {
        return reply.status(400).send({ success: false, message: 'Product already exists in your local store inventory' });
    }

    const newStoreInventory = new StoreInventory({
        storeId,
        masterProductId,
        variantId,
        sellingPrice, // Stores set their own local Rs price
        stock: stock || 0,
        lowStockThreshold: lowStockThreshold || 5
    });

    await newStoreInventory.save();

    return {
        success: true,
        message: 'Product successfully integrated into local inventory',
        data: newStoreInventory
    };
};
