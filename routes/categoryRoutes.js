const Category = require('../models/Category');

async function categoryRoutes(fastify, options) {
    // GET /api/categories - Fetch all categories
    fastify.get('/api/categories', async (request, reply) => {
        try {
            const filter = request.query.all === 'true' ? {} : { isActive: true };
            const categories = await Category.find(filter).sort({ section: 1, name: 1 });
            return { success: true, count: categories.length, data: categories };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching categories' });
        }
    });

    // POST /api/categories - Add a new category
    fastify.post('/api/categories', async (request, reply) => {
        try {
            const { name, section, imageUrl } = request.body;
            const newCategory = new Category({ name, section, imageUrl });
            await newCategory.save();
            return { success: true, message: 'Category created successfully', data: newCategory };
        } catch (error) {
            // Handle duplicate category names
            if (error.code === 11000) {
                return reply.status(400).send({ success: false, message: 'A category with this name already exists' });
            }
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating category' });
        }
    });

    // DELETE /api/categories/:id - Delete a category
    fastify.delete('/api/categories/:id', async (request, reply) => {
        try {
            const result = await Category.findByIdAndDelete(request.params.id);
            if (!result) return reply.status(404).send({ success: false, message: 'Category not found' });
            return { success: true, message: 'Category deleted successfully' };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error deleting category' });
        }
    });
}

module.exports = categoryRoutes;
