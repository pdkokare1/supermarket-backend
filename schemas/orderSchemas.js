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
                customerPhone: { type: 'string' },
                items: { type: 'array' },
                totalAmount: { type: 'number' },
                taxAmount: { type: 'number' },
                discountAmount: { type: 'number' },
                paymentMethod: { type: 'string' },
                pointsRedeemed: { type: 'number' },
                notes: { type: 'string' },
                storeId: { type: 'string' }, 
                registerId: { type: 'string' } 
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
                customerName: { type: 'string' },
                customerPhone: { type: 'string' },
                deliveryAddress: { type: 'string' },
                items: { type: 'array' },
                totalAmount: { type: 'number' },
                paymentMethod: { type: 'string' },
                deliveryType: { type: 'string' },
                scheduleTime: { type: 'string' },
                notes: { type: 'string' },
                storeId: { type: 'string' } 
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
                source: { type: 'string' }, 
                externalOrderId: { type: 'string' },
                customerName: { type: 'string' },
                customerPhone: { type: 'string' },
                deliveryAddress: { type: 'string' },
                items: { type: 'array' },
                totalAmount: { type: 'number' },
                paymentMethod: { type: 'string' },
                notes: { type: 'string' },
                storeId: { type: 'string' }
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

const statusSchema = { schema: { body: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string' } } } } };
const cancelSchema = { schema: { body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string' } } } } };
const assignDriverSchema = { schema: { body: { type: 'object', additionalProperties: false, required: ['driverName'], properties: { driverName: { type: 'string' }, driverPhone: { type: 'string' } } } } };

const getOrdersSchema = {
    schema: {
        querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
                tab: { type: 'string' },
                dateFilter: { type: 'string' },
                page: { type: 'string' },
                limit: { type: 'string' },
                cursor: { type: 'string' } 
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
