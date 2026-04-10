/* utils/paginationUtils.js */
'use strict';

/**
 * Centrally handles pagination and sorting logic for MongoDB/Mongoose queries.
 */
const getPaginationOptions = (query) => {
    const page = parseInt(query.page, 10) || 1;
    const limit = parseInt(query.limit, 10) || 0; // 0 indicates no limit (fetch all)
    const skip = (page - 1) * limit;

    return { page, limit, skip };
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
