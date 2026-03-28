/* schemas/authSchemas.js */

const loginSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['username', 'pin'],
            properties: {
                username: { type: 'string' },
                pin: { type: 'string' }
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
                id: { type: 'string' }
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
