/* services/productService.js */
'use strict';

const Product = require('../models/Product');
const cacheUtils = require('../utils/cacheUtils');
const appEvents = require('../utils/eventEmitter');
const { buildProductQuery } = require('../utils/queryBuilderUtils');
const { getPaginationOptions, getSortQuery } = require('../utils/paginationUtils');

// CONFIGURATION: Centralized Cache TTL (1 hour)
const CACHE_TTL = 3600;

const invalidateProductCache = async () => {
    await cacheUtils.invalidateByPattern('products:*');
};

// MODULARITY: Helper to handle all post-update side effects in one place
const triggerProductUpdates = async (productId) => {
    await invalidateProductCache();
    appEvents.emit('PRODUCT_UPDATED', { productId });
};

exports.getPaginatedProducts = async (queryParams) => {
    const cacheKey = cacheUtils.generateKey('products', queryParams);
    const cachedData = await cacheUtils.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    const filter = buildProductQuery(queryParams); 
    const { limit, skip } = getPaginationOptions(queryParams);
    const sortQuery = getSortQuery(queryParams.sort);
    
    let query = Product.find(filter).select('-variants.purchaseHistory -variants.returnHistory').sort(sortQuery);
    if (limit > 0) query = query.skip(skip).limit(limit); 
    
    const [products, total] = await Promise.all([query.lean(), Product.countDocuments(filter)]);
    const responseData = { success: true, count: products.length, total: total, data: products };
    await cacheUtils.setCachedData(cacheKey, responseData, CACHE_TTL);
    
    return responseData;
};

exports.createProduct = async (productData) => {
    const newProduct = new Product(productData);
    await newProduct.save();
    await triggerProductUpdates(newProduct._id);
    return newProduct;
};

exports.updateProduct = async (productId, updateData) => {
    const { _id, isArchived, isActive, ...safeUpdateData } = updateData;
    const updatedProduct = await Product.findByIdAndUpdate(productId, { $set: safeUpdateData }, { new: true, runValidators: true });
    if (updatedProduct) {
        await triggerProductUpdates(updatedProduct._id);
    }
    return updatedProduct;
};

exports.archiveProduct = async (productId) => {
    const product = await Product.findById(productId);
    if (!product) return null;
    product.isArchived = true; 
    product.isActive = false; 
    await product.save();
    await triggerProductUpdates(product._id);
    return product;
};

exports.toggleProductStatus = async (productId) => {
    const product = await Product.findById(productId);
    if (!product) return null;
    product.isActive = !product.isActive; 
    await product.save();
    await triggerProductUpdates(product._id);
    return product;
};
