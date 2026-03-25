const Category = require('../models/Category');

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
    fastify.get('/api/categories', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            // --- OPTIMIZATION: Added .lean() for faster memory allocation ---
            const categories = await Category.find().sort({ name: 1 }).lean();
            return { success: true, count: categories.length, data: categories };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching categories' });
        }
    });

    // POST /api/categories - Add a new category
    fastify.post('/api/categories', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...categorySchema }, async (request, reply) => {
        try {
            const { name } = request.body;
            const newCategory = new Category({ name });
            await newCategory.save();
            
            // --- NEW: Real-Time POS Notification for Navigation Sync ---
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'CATEGORY_ADDED', categoryId: newCategory._id });

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
