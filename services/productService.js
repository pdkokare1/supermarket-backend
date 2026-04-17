/* services/productService.js */
'use strict';

const Product = require('../models/Product');
const cacheUtils = require('../utils/cacheUtils');
const appEvents = require('../utils/eventEmitter');
const { buildProductQuery } = require('../utils/queryBuilderUtils');
const { getPaginationOptions, getSortQuery } = require('../utils/paginationUtils');
const { fetchWithCoalescing } = require('./productCacheService'); // DOMAIN INTEGRATION

// CONFIGURATION: Centralized Cache TTL (1 hour)
const CACHE_TTL = 3600;

// MODULARITY: Strictly event-driven. Redis invalidation is deferred to event listeners.
const triggerProductUpdates = async (productId) => {
    appEvents.emit('PRODUCT_UPDATED', { productId, pattern: 'products:*' });
};

exports.getPaginatedProducts = async (queryParams) => {
    const cacheKey = cacheUtils.generateKey('products', queryParams);
    
    // OPTIMIZATION: Cold Start / Cache Stampede Protection
    // Wraps the heavy DB aggregation in the coalescing engine to ensure concurrent traffic spikes only trigger 1 database read.
    return await fetchWithCoalescing(cacheKey, CACHE_TTL, async () => {
        const filter = buildProductQuery(queryParams); 
        const { limit, skip } = getPaginationOptions(queryParams);
        const sortQuery = getSortQuery(queryParams.sort);
        
        // OPTIMIZATION: Single-pass aggregation replacing find() and countDocuments()
        // ENTERPRISE FIX: allowDiskUse(true) prevents the 100MB RAM limit crash on large collections utilizing $facet
        const result = await Product.aggregate([
            { $match: filter },
            { $facet: {
                metadata: [ { $count: "total" } ],
                data: [
                    { $sort: sortQuery || { createdAt: -1 } },
                    { $skip: skip },
                    { $limit: limit || 50 },
                    { $project: { "variants.purchaseHistory": 0, "variants.returnHistory": 0 } }
                ]
            }}
        ]).allowDiskUse(true);

        const products = result[0].data;
        const total = result[0].metadata[0]?.total || 0;

        return { success: true, message: 'Products fetched successfully', count: products.length, total: total, data: products };
    });
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
