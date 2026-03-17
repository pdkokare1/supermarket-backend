const Brand = require('../models/Brand');

async function brandRoutes(fastify, options) {
    fastify.get('/api/brands', async (request, reply) => {
        try {
            const brands = await Brand.find().sort({ name: 1 });
            return { success: true, count: brands.length, data: brands };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching brands' });
        }
    });

    fastify.post('/api/brands', async (request, reply) => {
        try {
            const { name } = request.body;
            const newBrand = new Brand({ name });
            await newBrand.save();
            return { success: true, message: 'Brand added', data: newBrand };
        } catch (error) {
            if (error.code === 11000) return reply.status(400).send({ success: false, message: 'Brand already exists' });
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating brand' });
        }
    });
}

module.exports = brandRoutes;
