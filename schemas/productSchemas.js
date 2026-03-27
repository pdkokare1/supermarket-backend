/* schemas/productSchemas.js */

const productSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['name', 'category'],
            properties: {
                name: { type: 'string' },
                category: { type: 'string' },
                brand: { type: 'string' },
                distributorName: { type: 'string' },
                imageUrl: { type: 'string' },
                searchTags: { type: 'string' },
                hsnCode: { type: 'string' },
                taxRate: { type: 'number' },
                taxType: { type: 'string', enum: ['Inclusive', 'Exclusive'] }
            }
        }
    }
};

const restockSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['variantId', 'addedQuantity', 'purchasingPrice', 'newSellingPrice'],
            properties: {
                variantId: { type: 'string' },
                invoiceNumber: { type: 'string' },
                addedQuantity: { type: 'number', minimum: 1 },
                purchasingPrice: { type: 'number', minimum: 0 },
                newSellingPrice: { type: 'number', minimum: 0 },
                paymentStatus: { type: 'string', enum: ['Paid', 'Credit'] }, 
                storeId: { type: 'string' } 
            }
        }
    }
};

const rtvSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['variantId', 'returnedQuantity', 'refundAmount'],
            properties: {
                variantId: { type: 'string' },
                distributorName: { type: 'string' },
                returnedQuantity: { type: 'number', minimum: 1 },
                refundAmount: { type: 'number', minimum: 0 },
                reason: { type: 'string' },
                storeId: { type: 'string' } 
            }
        }
    }
};

const getProductsSchema = {
    schema: {
        querystring: {
            type: 'object',
            properties: {
                all: { type: 'string' },
                search: { type: 'string' },
                category: { type: 'string' },
                brand: { type: 'string' },
                distributor: { type: 'string' },
                stockStatus: { type: 'string' },
                page: { type: 'string' },
                limit: { type: 'string' },
                sort: { type: 'string' }
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
