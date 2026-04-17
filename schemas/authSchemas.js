/* schemas/authSchemas.js */

const loginSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['username', 'pin'],
            properties: {
                // OPTIMIZATION: Strict constraints to prevent DoS attacks through excessive payload hashing times
                username: { type: 'string', maxLength: 50 },
                pin: { type: 'string', maxLength: 255 }
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
            required: ['id'],
            properties: {
                id: { type: 'string', maxLength: 100 }
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
