/* services/productService.js */
'use strict';

const Product = require('../models/Product');
const cacheUtils = require('../utils/cacheUtils');
const { buildProductQuery } = require('../utils/queryBuilderUtils');

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

// OPTIMIZED: Removed Fastify server dependency. 
// The service now strictly handles data and caching.
const invalidateProductCache = async () => {
    await cacheUtils.invalidateByPattern('products:*');
};

// ==========================================
// --- SERVICE EXPORTS ---
// ==========================================

exports.getPaginatedProducts = async (queryParams) => {
    const cacheKey = cacheUtils.generateKey('products', queryParams);
    const cachedData = await cacheUtils.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    const filter = buildProductQuery(queryParams); 
    const page = parseInt(queryParams.page) || 1; 
    const limit = parseInt(queryParams.limit); 
    
    let sortQuery = { createdAt: -1 };
    if (queryParams.sort === 'name_asc') sortQuery = { name: 1 };
    if (queryParams.sort === 'stock_low') sortQuery = { "variants.stock": 1 }; 
    
    let query = Product.find(filter).sort(sortQuery);
    if (limit) query = query.skip((page - 1) * limit).limit(limit); 
    
    const [products, total] = await Promise.all([query.lean(), Product.countDocuments(filter)]);
    
    const responseData = { success: true, count: products.length, total: total, data: products };
    await cacheUtils.setCachedData(cacheKey, responseData, 3600);
    
    return responseData;
};

// OPTIMIZED: Removed 'server' parameter.
exports.createProduct = async (productData) => {
    const newProduct = new Product(productData);
    await newProduct.save();
    await invalidateProductCache();
    return newProduct;
};

// OPTIMIZED: Removed 'server' parameter.
exports.updateProduct = async (productId, updateData) => {
    const { _id, isArchived, isActive, ...safeUpdateData } = updateData;
    
    const updatedProduct = await Product.findByIdAndUpdate(
        productId, 
        { $set: safeUpdateData }, 
        { new: true, runValidators: true }
    );
    
    if (updatedProduct) await invalidateProductCache();
    return updatedProduct;
};

// OPTIMIZED: Removed 'server' parameter.
exports.archiveProduct = async (productId) => {
    const product = await Product.findById(productId);
    if (!product) return null;
    
    product.isArchived = true; 
    product.isActive = false; 
    await product.save();
    
    await invalidateProductCache();
    return product;
};

// OPTIMIZED: Removed 'server' parameter.
exports.toggleProductStatus = async (productId) => {
    const product = await Product.findById(productId);
    if (!product) return null;
    
    product.isActive = !product.isActive; 
    await product.save();
    
    await invalidateProductCache();
    return product;
};
