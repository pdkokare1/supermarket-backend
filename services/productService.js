/* services/productService.js */

const Product = require('../models/Product');
const cacheUtils = require('../utils/cacheUtils');

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

const syncAndBroadcast = async (server, productId, extraPayload = {}) => {
    await cacheUtils.invalidateByPattern('products:*');
    if (server && server.broadcastToPOS) {
        server.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId, ...extraPayload });
    }
};

// OPTIMIZED: Defined as a local constant to prevent 'this' context loss
const buildProductQuery = (queryObj) => {
    let filter = queryObj.all === 'true' 
        ? { isArchived: { $ne: true } } 
        : { isActive: true, isArchived: { $ne: true } };
    
    if (queryObj.search) { 
        filter.$or = [ 
            { name: { $regex: queryObj.search, $options: 'i' } }, 
            { searchTags: { $regex: queryObj.search, $options: 'i' } } 
        ]; 
    }
    
    if (queryObj.category && queryObj.category !== 'All') filter.category = queryObj.category; 
    if (queryObj.brand && queryObj.brand !== 'All') filter.brand = queryObj.brand;
    if (queryObj.distributor && queryObj.distributor !== 'All') filter.distributorName = queryObj.distributor;

    if (queryObj.stockStatus === 'out') {
        filter['variants.stock'] = { $lte: 0 };
    } else if (queryObj.stockStatus === 'dead') {
        filter['variants.stock'] = { $gt: 15 };
    } else if (queryObj.stockStatus === 'low') {
        filter.$expr = {
            $anyElementTrue: {
                $map: {
                    input: "$variants", as: "v", in: {
                        $and: [
                            { $gt: ["$$v.stock", 0] },
                            { $lte: ["$$v.stock", { $ifNull: ["$$v.lowStockThreshold", 5] }] }
                        ]
                    }
                }
            }
        };
    }
    return filter;
};

exports.buildProductQuery = buildProductQuery; // Re-export for external use

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
    // Protected fields stripped here for security
    delete updateData._id;
    delete updateData.isArchived;
    delete updateData.isActive;
    
    const updatedProduct = await Product.findByIdAndUpdate(
        productId, 
        { $set: updateData }, 
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
