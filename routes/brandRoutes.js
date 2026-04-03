/* routes/brandRoutes.js */

const brandController = require('../controllers/brandController');

const brandSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['name'],
            properties: {
                name: { type: 'string' }
            }
        }
    }
};

async function brandRoutes(fastify, options) {
    fastify.get('/api/brands', { preHandler: [fastify.authenticate] }, brandController.getBrands);
    fastify.post('/api/brands', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...brandSchema }, brandController.createBrand);
}

module.exports = brandRoutes;
