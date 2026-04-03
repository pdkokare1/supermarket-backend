/* services/productService.js */

const Product = require('../models/Product');
const cacheUtils = require('../utils/cacheUtils');
const { buildProductQuery } = require('../utils/queryBuilderUtils');

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

const syncAndBroadcast = async (server, productId, extraPayload = {}) => {
    await cacheUtils.invalidateByPattern('products:*');
    if (server && server.broadcastToPOS) {
        server.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId, ...extraPayload });
    }
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

exports.createProduct = async (server, productData) => {
    const newProduct = new Product(productData);
    await newProduct.save();
    await syncAndBroadcast(server, newProduct._id);
    return newProduct;
};

exports.updateProduct = async (server, productId, updateData) => {
    // V8 Engine Optimization: Destructuring instead of 'delete' operator
    const { _id, isArchived, isActive, ...safeUpdateData } = updateData;
    
    const updatedProduct = await Product.findByIdAndUpdate(
        productId, 
        { $set: safeUpdateData }, 
        { new: true, runValidators: true }
    );
    
    if (updatedProduct) await syncAndBroadcast(server, updatedProduct._id);
    return updatedProduct;
};

exports.archiveProduct = async (server, productId) => {
    const product = await Product.findById(productId);
    if (!product) return null;
    
    product.isArchived = true; 
    product.isActive = false; 
    await product.save();
    
    await syncAndBroadcast(server, product._id);
    return product;
};

exports.toggleProductStatus = async (server, productId) => {
    const product = await Product.findById(productId);
    if (!product) return null;
    
    product.isActive = !product.isActive; 
    await product.save();
    
    await syncAndBroadcast(server, product._id);
    return product;
};
