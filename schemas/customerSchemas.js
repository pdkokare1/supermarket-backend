/* schemas/customerSchemas.js */

const limitSchema = { 
    schema: { 
        body: { 
            type: 'object', 
            required: ['isCreditEnabled', 'creditLimit'], 
            properties: { 
                isCreditEnabled: { type: 'boolean' }, 
                creditLimit: { type: 'number' }, 
                name: { type: 'string' } 
            } 
        } 
    } 
};

const paySchema = { 
    schema: { 
        body: { 
            type: 'object', 
            required: ['amount'], 
            properties: { 
                amount: { type: 'number', minimum: 0 } 
            } 
        } 
    } 
};

module.exports = {
    limitSchema,
    paySchema
};
