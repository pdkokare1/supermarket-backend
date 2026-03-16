const Category = require('../models/Category');

async function categoryRoutes(fastify, options) {
    // GET /api/categories - Fetch all categories
    fastify.get('/api/categories', async (request, reply) => {
        try {
            const categories = await Category.find().sort({ name: 1 });
            return { success: true, count: categories.length, data: categories };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching categories' });
        }
    });

    // POST /api/categories - Add a new category
    fastify.post('/api/categories', async (request, reply) => {
        try {
            const { name } = request.body;
            const newCategory = new Category({ name });
            await newCategory.save();
            return { success: true, message: 'Category added', data: newCategory };
        } catch (error) {
            if (error.code === 11000) {
                return reply.status(400).send({ success: false, message: 'Category already exists' });
            }
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating category' });
        }
    });
}

module.exports = categoryRoutes;
