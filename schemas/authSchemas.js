/* schemas/authSchemas.js */

const loginSchema = {
    schema: {
        body: {
            type: 'object',
            additionalProperties: false, // SECURITY FIX: Prototype pollution & bloat defense
            required: ['username', 'pin'],
            properties: {
                // OPTIMIZATION: Strict constraints to prevent DoS attacks through excessive payload hashing times
                username: { type: 'string', maxLength: 50 },
                pin: { type: 'string', maxLength: 255 }
            }
        },
        response: {
            200: {
                type: 'object',
                properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string' },
                    token: { type: 'string' },
                    data: { type: 'object', additionalProperties: true }
                }
            }
        }
    },
    config: {
        rateLimit: {
            max: 5, 
            timeWindow: '15 minutes'
        }
    }
};

const verifySchema = {
    schema: {
        querystring: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: {
                id: { type: 'string', maxLength: 100 }
            }
        },
        response: {
            200: {
                type: 'object',
                properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string' },
                    data: { type: 'object', additionalProperties: true }
                }
            }
        }
    }
};

const setupRateLimit = {
    config: {
        rateLimit: {
            max: 3,
            timeWindow: '60 minutes'
        }
    }
};

module.exports = {
    loginSchema,
    verifySchema,
    setupRateLimit
};
