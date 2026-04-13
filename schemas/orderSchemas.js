/* schemas/orderSchemas.js */

// DEPRECATION CONSULTATION: Loose schemas cause slow V8 parsing and prototype pollution risks.
/*
const posCheckoutSchema = { schema: { body: { type: 'object', required: ['items', 'totalAmount'], properties: { customerPhone: { type: 'string' }, items: { type: 'array' }, totalAmount: { type: 'number' }, taxAmount: { type: 'number' }, discountAmount: { type: 'number' }, paymentMethod: { type: 'string' }, pointsRedeemed: { type: 'number' }, notes: { type: 'string' }, storeId: { type: 'string' }, registerId: { type: 'string' } } } } };
const onlineCheckoutSchema = { schema: { body: { type: 'object', required: ['items', 'totalAmount', 'customerName', 'customerPhone', 'deliveryAddress'], properties: { customerName: { type: 'string' }, customerPhone: { type: 'string' }, deliveryAddress: { type: 'string' }, items: { type: 'array' }, totalAmount: { type: 'number' }, paymentMethod: { type: 'string' }, deliveryType: { type: 'string' }, scheduleTime: { type: 'string' }, notes: { type: 'string' }, storeId: { type: 'string' } } } } };
const externalCheckoutSchema = { schema: { body: { type: 'object', required: ['items', 'totalAmount', 'source'], properties: { source: { type: 'string' }, externalOrderId: { type: 'string' }, customerName: { type: 'string' }, customerPhone: { type: 'string' }, deliveryAddress: { type: 'string' }, items: { type: 'array' }, totalAmount: { type: 'number' }, paymentMethod: { type: 'string' }, notes: { type: 'string' }, storeId: { type: 'string' } } } } };
const statusSchema = { schema: { body: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } } } };
const cancelSchema = { schema: { body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } } };
const assignDriverSchema = { schema: { body: { type: 'object', required: ['driverName'], properties: { driverName: { type: 'string' }, driverPhone: { type: 'string' } } } } };
const getOrdersSchema = { schema: { querystring: { type: 'object', properties: { tab: { type: 'string' }, dateFilter: { type: 'string' }, page: { type: 'string' }, limit: { type: 'string' } } } } };
*/

// OPTIMIZATION: Strict 'additionalProperties: false' forces Fastify into hyper-optimized C++ native parsing
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
                cursor: { type: 'string' } // Maintained from our previous pagination upgrade
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
