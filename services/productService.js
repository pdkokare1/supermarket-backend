/* services/productService.js */

exports.buildProductQuery = (queryObj) => {
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
