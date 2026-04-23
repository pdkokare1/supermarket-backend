/* schemas/productSchemas.js */

// DEPRECATION CONSULTATION:
/*
const productSchema = { schema: { body: { type: 'object', required: ['name', 'category'], properties: { name: { type: 'string' }, category: { type: 'string' }, brand: { type: 'string' }, distributorName: { type: 'string' }, imageUrl: { type: 'string' }, searchTags: { type: 'string' }, hsnCode: { type: 'string' }, taxRate: { type: 'number' }, taxType: { type: 'string', enum: ['Inclusive', 'Exclusive'] } } } } };
const restockSchema = { schema: { body: { type: 'object', required: ['variantId', 'addedQuantity', 'purchasingPrice', 'newSellingPrice'], properties: { variantId: { type: 'string' }, invoiceNumber: { type: 'string' }, addedQuantity: { type: 'number', minimum: 1 }, purchasingPrice: { type: 'number', minimum: 0 }, newSellingPrice: { type: 'number', minimum: 0 }, paymentStatus: { type: 'string', enum: ['Paid', 'Credit'] }, storeId: { type: 'string' } } } } };
const rtvSchema = { schema: { body: { type: 'object', required: ['variantId', 'returnedQuantity', 'refundAmount'], properties: { variantId: { type: 'string' }, distributorName: { type: 'string' }, returnedQuantity: { type: 'number', minimum: 1 }, refundAmount: { type: 'number', minimum: 0 }, reason: { type: 'string' }, storeId: { type: 'string' } } } } };
const getProductsSchema = { schema: { querystring: { type: 'object', properties: { all: { type: 'string' }, search: { type: 'string' }, category: { type: 'string' }, brand: { type: 'string' }, distributor: { type: 'string' }, stockStatus: { type: 'string' }, page: { type: 'string' }, limit: { type: 'string' }, sort: { type: 'string' } } } } };
*/

// OPTIMIZATION: Added strict validation
const productSchema = {
    schema: {
        body: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'category'],
            properties: {
                name: { type: 'string', maxLength: 200 },
                category: { type: 'string', maxLength: 100 },
                brand: { type: 'string', maxLength: 100 },
                distributorName: { type: 'string', maxLength: 100 },
                imageUrl: { type: 'string', maxLength: 1000 },
                searchTags: { type: 'string', maxLength: 500 },
                hsnCode: { type: 'string', maxLength: 50 },
                taxRate: { type: 'number', minimum: 0, maximum: 100 },
                taxType: { type: 'string', enum: ['Inclusive', 'Exclusive'] }
            }
        },
        response: {
            201: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'object', additionalProperties: true } } },
            200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'object', additionalProperties: true } } }
        }
    }
};

const restockSchema = {
    schema: {
        body: {
            type: 'object',
            additionalProperties: false,
            required: ['variantId', 'addedQuantity', 'purchasingPrice', 'newSellingPrice'],
            properties: {
                variantId: { type: 'string', maxLength: 50 },
                invoiceNumber: { type: 'string', maxLength: 100 },
                addedQuantity: { type: 'number', minimum: 1, maximum: 1000000 },
                purchasingPrice: { type: 'number', minimum: 0, maximum: 10000000 },
                newSellingPrice: { type: 'number', minimum: 0, maximum: 10000000 },
                paymentStatus: { type: 'string', enum: ['Paid', 'Credit'] }, 
                storeId: { type: 'string', maxLength: 50 } 
            }
        },
        response: {
            200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'object', additionalProperties: true } } }
        }
    }
};

const rtvSchema = {
    schema: {
        body: {
            type: 'object',
            additionalProperties: false,
            required: ['variantId', 'returnedQuantity', 'refundAmount'],
            properties: {
                variantId: { type: 'string', maxLength: 50 },
                distributorName: { type: 'string', maxLength: 100 },
                returnedQuantity: { type: 'number', minimum: 1, maximum: 1000000 },
                refundAmount: { type: 'number', minimum: 0, maximum: 10000000 },
                reason: { type: 'string', maxLength: 500 },
                storeId: { type: 'string', maxLength: 50 } 
            }
        },
        response: {
            200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'object', additionalProperties: true } } }
        }
    }
};

const getProductsSchema = {
    schema: {
        querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
                all: { type: 'string', maxLength: 10 },
                search: { type: 'string', maxLength: 200 },
                category: { type: 'string', maxLength: 100 },
                brand: { type: 'string', maxLength: 100 },
                distributor: { type: 'string', maxLength: 100 },
                stockStatus: { type: 'string', maxLength: 20 },
                page: { type: 'string', maxLength: 10 },
                limit: { type: 'string', maxLength: 10 },
                sort: { type: 'string', maxLength: 50 },
                cursor: { type: 'string', maxLength: 100 }
            }
        },
        response: {
            200: {
                type: 'object',
                properties: {
                    success: { type: 'boolean' },
                    count: { type: 'number' },
                    total: { type: 'number' },
                    nextCursor: { type: 'string', nullable: true },
                    data: { type: 'array', items: { type: 'object', additionalProperties: true } }
                }
            }
        }
    }
};

module.exports = {
    productSchema,
    restockSchema,
    rtvSchema,
    getProductsSchema
};
