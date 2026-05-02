/* utils/queryBuilderUtils.js */
const mongoose = require('mongoose');

// OPTIMIZATION: Helper function to neutralize regex control characters and prevent ReDoS attacks.
const escapeRegex = (string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const buildProductQuery = (queryObj) => {
    let filter = queryObj.all === 'true' 
        ? { isArchived: { $ne: true } } 
        : { isActive: true, isArchived: { $ne: true } };
    
    if (queryObj.search) { 
        // ENTERPRISE OPTIMIZATION: Native $text index support for scalable search,
        // while preserving the original $regex for partial match backwards compatibility.
        if (queryObj.exactMatch === 'true') {
            filter.$text = { $search: queryObj.search };
        } else {
            // OPTIMIZATION: Applied escapeRegex to the user input before executing the database scan
            const safeSearch = escapeRegex(queryObj.search);
            filter.$or = [ 
                { name: { $regex: safeSearch, $options: 'i' } }, 
                { searchTags: { $regex: safeSearch, $options: 'i' } } 
            ]; 
        }
    }
    
    if (queryObj.category && queryObj.category !== 'All') filter.category = queryObj.category; 
    if (queryObj.brand && queryObj.brand !== 'All') filter.brand = queryObj.brand;

    // DELETED: variants.stock and distributor logic. 
    // Reason: MasterProduct is global and contains no local volatile stock data.

    // ENTERPRISE OPTIMIZATION: Cursor-based pagination prep (O(1) lookup time)
    if (queryObj.cursor) {
        filter._id = { $lt: new mongoose.Types.ObjectId(queryObj.cursor) };
    }

    return filter;
};

// NEW: Function strictly for Tenant/Store Inventory filtering
const buildInventoryQuery = (queryObj, storeId) => {
    let filter = { storeId: new mongoose.Types.ObjectId(storeId) };

    if (queryObj.all !== 'true') {
        filter.isActive = true;
    }

    // Optional distributor filter via recent purchase history
    if (queryObj.distributor && queryObj.distributor !== 'All') {
         filter['purchaseHistory.distributorName'] = queryObj.distributor;
    }

    // Stock status filtering applied directly to the root-level stock integer
    if (queryObj.stockStatus === 'out') {
        filter.stock = { $lte: 0 };
    } else if (queryObj.stockStatus === 'dead') {
        filter.stock = { $gt: 15 };
    } else if (queryObj.stockStatus === 'low') {
        filter.$expr = {
            $and: [
                { $gt: ["$stock", 0] },
                { $lte: ["$stock", { $ifNull: ["$lowStockThreshold", 5] }] }
            ]
        };
    }

    // --- NEW: B2B Omnichannel Safety Check ---
    // If the Master Query bridge found 0 matching master products, but a search term existed,
    // we must force the inventory query to return 0 results instead of pulling everything.
    if (queryObj.search && !filter.masterProductId && queryObj._masterSearchExecuted) {
        filter.masterProductId = null; // Forces 0 matches
    }

    // ENTERPRISE OPTIMIZATION: Cursor-based pagination prep
    if (queryObj.cursor) {
        filter._id = { $lt: new mongoose.Types.ObjectId(queryObj.cursor) };
    }

    return filter;
};

module.exports = { buildProductQuery, buildInventoryQuery };
