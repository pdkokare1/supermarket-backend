/* services/productService.js */

const Product = require('../models/Product');
const cacheUtils = require('../utils/cacheUtils');

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

exports.getPaginatedProducts = async (queryParams) => {
    const cacheKey = cacheUtils.generateKey('products', queryParams);
    const cachedData = await cacheUtils.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    const filter = buildProductQuery(queryParams); // OPTIMIZED: Removed 'this.' dependency
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
