/* utils/paginationUtils.js */
'use strict';

/**
 * Centrally handles pagination and sorting logic for MongoDB/Mongoose queries.
 */
const getPaginationOptions = (query) => {
    const page = parseInt(query.page, 10) || 1;
    const limit = parseInt(query.limit, 10) || 0; // 0 indicates no limit (fetch all)
    
    // DEPRECATION CONSULTATION: Standard skip/limit becomes O(N) slow on large DBs.
    // We keep it for backwards compatibility, but enterprise queries should use cursors.
    const skip = (page - 1) * limit;

    // OPTIMIZATION: Added Cursor extraction for O(1) high-performance pagination
    const cursor = query.cursor || null;

    return { page, limit, skip, cursor };
};

const getSortQuery = (sortType, defaultSort = { createdAt: -1 }) => {
    const sortMap = {
        'name_asc': { name: 1 },
        'name_desc': { name: -1 },
        'stock_low': { "variants.stock": 1 },
        'stock_high': { "variants.stock": -1 },
        'newest': { createdAt: -1 },
        'oldest': { createdAt: 1 }
    };

    return sortMap[sortType] || defaultSort;
};

module.exports = { getPaginationOptions, getSortQuery };
