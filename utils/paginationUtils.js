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

// OPTIMIZATION: Enterprise Cursor Filter generation for O(1) pagination
const getCursorFilter = (cursor, sortOrder = -1) => {
    if (!cursor) return {};
    
    // Using the last seen document _id as the anchor point.
    // If sorting newest to oldest (-1), we want items older ($lt) than the cursor.
    // If sorting oldest to newest (1), we want items newer ($gt) than the cursor.
    return sortOrder === -1 ? { _id: { $lt: cursor } } : { _id: { $gt: cursor } };
};

module.exports = { getPaginationOptions, getSortQuery, getCursorFilter };
