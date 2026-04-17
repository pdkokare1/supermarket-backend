/* schemas/orderSchemas.js */

// DEPRECATION CONSULTATION: Previous implementation optimized inputs, but left outputs to slow generic JSON stringification.
/*
const posCheckoutSchema = { schema: { body: { ... } } };
const onlineCheckoutSchema = { schema: { body: { ... } } };
...
*/

// OPTIMIZATION: Edge Validation + Serialization. 
// Adding `response` schemas forces Fastify to compile ultra-fast native C++ serializers, bypassing JSON.stringify entirely.

const posCheckoutSchema = {
    schema: {
        body: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'totalAmount'],
            properties: {
                customerPhone: { type: 'string', maxLength: 20 },
                // OPTIMIZATION: Strict maxItems protects V8 memory from array-bloat attacks
                items: { type: 'array', maxItems: 300 },
                totalAmount: { type: 'number', minimum: 0, maximum: 10000000 },
                taxAmount: { type: 'number', minimum: 0 },
                discountAmount: { type: 'number', minimum: 0 },
                paymentMethod: { type: 'string', maxLength: 50 },
                pointsRedeemed: { type: 'number', minimum: 0 },
                notes: { type: 'string', maxLength: 500 },
                storeId: { type: 'string', maxLength: 50 }, 
                registerId: { type: 'string', maxLength: 50 } 
            }
        },
        response: {
            201: {
                type: 'object',
                properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string' },
                    orderId: { type: 'string' }
                }
            }
        }
    }
};

const onlineCheckoutSchema = {
    schema: {
        body: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'totalAmount', 'customerName', 'customerPhone', 'deliveryAddress'],
            properties: {
                customerName: { type: 'string', maxLength: 100 },
                customerPhone: { type: 'string', maxLength: 20 },
                deliveryAddress: { type: 'string', maxLength: 500 },
                items: { type: 'array', maxItems: 300 },
                totalAmount: { type: 'number', minimum: 0, maximum: 10000000 },
                paymentMethod: { type: 'string', maxLength: 50 },
                deliveryType: { type: 'string', maxLength: 50 },
                scheduleTime: { type: 'string', maxLength: 100 },
                notes: { type: 'string', maxLength: 500 },
                storeId: { type: 'string', maxLength: 50 } 
            }
        },
        response: {
            201: {
                type: 'object',
                properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string' },
                    orderId: { type: 'string' }
                }
            }
        }
    }
};

const externalCheckoutSchema = {
    schema: {
        body: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'totalAmount', 'source'],
            properties: {
                source: { type: 'string', maxLength: 50 }, 
                externalOrderId: { type: 'string', maxLength: 100 },
                customerName: { type: 'string', maxLength: 100 },
                customerPhone: { type: 'string', maxLength: 20 },
                deliveryAddress: { type: 'string', maxLength: 500 },
                items: { type: 'array', maxItems: 300 },
                totalAmount: { type: 'number', minimum: 0, maximum: 10000000 },
                paymentMethod: { type: 'string', maxLength: 50 },
                notes: { type: 'string', maxLength: 500 },
                storeId: { type: 'string', maxLength: 50 }
            }
        },
        response: {
            201: {
                type: 'object',
                properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string' },
                    orderId: { type: 'string' },
                    orderNumber: { type: 'string' }
                }
            }
        }
    }
};

const statusSchema = { schema: { body: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', maxLength: 50 } } } } };
const cancelSchema = { schema: { body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', maxLength: 500 } } } } };
const assignDriverSchema = { schema: { body: { type: 'object', additionalProperties: false, required: ['driverName'], properties: { driverName: { type: 'string', maxLength: 100 }, driverPhone: { type: 'string', maxLength: 20 } } } } };

const getOrdersSchema = {
    schema: {
        querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
                tab: { type: 'string', maxLength: 50 },
                dateFilter: { type: 'string', maxLength: 50 },
                page: { type: 'string', maxLength: 10 },
                limit: { type: 'string', maxLength: 10 },
                cursor: { type: 'string', maxLength: 100 } 
            }
        }
    }
};

module.exports = {
    posCheckoutSchema,
    onlineCheckoutSchema,
    externalCheckoutSchema,
    statusSchema,
    cancelSchema,
    assignDriverSchema,
    getOrdersSchema
};
