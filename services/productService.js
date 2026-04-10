/* services/productService.js */
'use strict';

const Product = require('../models/Product');
const cacheUtils = require('../utils/cacheUtils');
const { buildProductQuery } = require('../utils/queryBuilderUtils');
const { getPaginationOptions, getSortQuery } = require('../utils/paginationUtils');

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

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
    
    // OPTIMIZED: Using centralized pagination and sorting utilities
    const { limit, skip } = getPaginationOptions(queryParams);
    const sortQuery = getSortQuery(queryParams.sort);
    
    let query = Product.find(filter)
        .select('-variants.purchaseHistory -variants.returnHistory')
        .sort(sortQuery);

    if (limit > 0) query = query.skip(skip).limit(limit); 
    
    const [products, total] = await Promise.all([
        query.lean(), 
        Product.countDocuments(filter)
    ]);
    
    const responseData = { success: true, count: products.length, total: total, data: products };
    await cacheUtils.setCachedData(cacheKey, responseData, 3600);
    
    return responseData;
};

exports.createProduct = async (productData) => {
    const newProduct = new Product(productData);
    await newProduct.save();
    await invalidateProductCache();
    return newProduct;
};

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

exports.archiveProduct = async (productId) => {
    const product = await Product.findById(productId);
    if (!product) return null;
    
    product.isArchived = true; 
    product.isActive = false; 
    await product.save();
    
    await invalidateProductCache();
    return product;
};

exports.toggleProductStatus = async (productId) => {
    const product = await Product.findById(productId);
    if (!product) return null;
    
    product.isActive = !product.isActive; 
    await product.save();
    
    await invalidateProductCache();
    return product;
};
