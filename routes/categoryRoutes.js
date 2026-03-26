const Category = require('../models/Category');

// --- NEW: Redis Setup for High-Speed Category Caching ---
let Redis = null;
let redisCache = null;
try {
    Redis = require('ioredis');
    if (process.env.REDIS_URL) {
        redisCache = new Redis(process.env.REDIS_URL);
    }
} catch (e) {
    // Graceful fallback if ioredis is not available
}

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
            // --- OPTIMIZATION: Check Redis Cache First ---
            if (redisCache) {
                const cachedCategories = await redisCache.get('categories:all');
                if (cachedCategories) {
                    return JSON.parse(cachedCategories);
                }
            }

            const categories = await Category.find().sort({ name: 1 }).lean();
            const responseData = { success: true, count: categories.length, data: categories };

            // --- OPTIMIZATION: Set Redis Cache (24 hours) ---
            if (redisCache) {
                await redisCache.set('categories:all', JSON.stringify(responseData), 'EX', 86400);
            }

            return responseData;
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
            
            // --- NEW: Invalidate Cache so the next fetch gets the new category ---
            if (redisCache) {
                await redisCache.del('categories:all');
            }
            
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
