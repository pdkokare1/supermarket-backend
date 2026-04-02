/* routes/categoryRoutes.js */

const categoryController = require('../controllers/categoryController');

const categorySchema = {
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

async function categoryRoutes(fastify, options) {
    // GET /api/categories - Fetch all categories
    fastify.get('/api/categories', { preHandler: [fastify.authenticate] }, categoryController.getCategories);

    // POST /api/categories - Add a new category
    fastify.post('/api/categories', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...categorySchema }, categoryController.createCategory);
}

module.exports = categoryRoutes;
