/* schemas/orderSchemas.js */

const posCheckoutSchema = {
    schema: {
        body: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'totalAmount'],
            properties: {
                customerPhone: { type: 'string', maxLength: 20 },
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
                    orderId: { type: 'string' },
                    orderData: { type: 'object', additionalProperties: true }
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
                storeId: { type: 'string', maxLength: 50 },
                notes: { type: 'string', maxLength: 500 },
                deliveryType: { type: 'string', maxLength: 50 },
                scheduleTime: { type: 'string', maxLength: 100 }
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
            required: ['source', 'externalOrderId', 'items', 'totalAmount'],
            properties: {
                source: { type: 'string', maxLength: 50 },
                externalOrderId: { type: 'string', maxLength: 100 },
                customerName: { type: 'string', maxLength: 100 },
                customerPhone: { type: 'string', maxLength: 20 },
                deliveryAddress: { type: 'string', maxLength: 500 },
                items: { type: 'array', maxItems: 300 },
                totalAmount: { type: 'number', minimum: 0, maximum: 10000000 },
                paymentMethod: { type: 'string', maxLength: 50 }
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

const assignDriverSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['driverName', 'driverPhone'],
            properties: {
                driverName: { type: 'string', maxLength: 100 },
                driverPhone: { type: 'string', maxLength: 20 }
            }
        }
    }
};

const statusSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['status'],
            properties: {
                status: { type: 'string', enum: ['Order Placed', 'Packing', 'Packed', 'Dispatched', 'Delivered', 'Cancelled', 'Returned'] }
            }
        }
    }
};

// ==========================================
// --- PHASE 3 OMNI-CART SCHEMA ---
// ==========================================

const omniCartCheckoutSchema = {
    schema: {
        body: {
            type: 'object',
            additionalProperties: false,
            required: ['carts', 'customerName', 'customerPhone', 'deliveryAddress'],
            properties: {
                customerName: { type: 'string', maxLength: 100 },
                customerPhone: { type: 'string', maxLength: 20 },
                deliveryAddress: { type: 'string', maxLength: 500 },
                notes: { type: 'string', maxLength: 500 },
                paymentMethod: { type: 'string', maxLength: 50 },
                transactionId: { type: 'string', maxLength: 100 },
                carts: {
                    type: 'array',
                    maxItems: 10,
                    items: {
                        type: 'object',
                        required: ['storeId', 'items', 'totalAmount'],
                        properties: {
                            storeId: { type: 'string', maxLength: 50, nullable: true },
                            items: { type: 'array', maxItems: 100 },
                            totalAmount: { type: 'number', minimum: 0 }
                        }
                    }
                }
            }
        },
        response: {
            201: {
                type: 'object',
                properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string' },
                    splitShipmentGroupId: { type: 'string' },
                    masterCartTotalRs: { type: 'number' },
                    totalShipments: { type: 'number' }
                }
            }
        }
    }
};

module.exports = {
    posCheckoutSchema,
    onlineCheckoutSchema,
    externalCheckoutSchema,
    assignDriverSchema,
    statusSchema,
    omniCartCheckoutSchema
};
