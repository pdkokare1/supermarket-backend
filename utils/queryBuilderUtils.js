/* utils/queryBuilderUtils.js */

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
        // OPTIMIZED: Replaced complex expression with $elemMatch for better indexing.
        filter.variants = {
            $elemMatch: {
                stock: { $gt: 0 },
                $expr: { $lte: ["$stock", { $ifNull: ["$lowStockThreshold", 5] }] }
            }
        };
    }
    return filter;
};

module.exports = { buildProductQuery };
