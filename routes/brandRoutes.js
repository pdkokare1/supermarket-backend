const Brand = require('../models/Brand');

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
    fastify.get('/api/brands', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            // --- OPTIMIZATION: Added .lean() for faster memory allocation ---
            const brands = await Brand.find().sort({ name: 1 }).lean();
            return { success: true, count: brands.length, data: brands };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching brands' });
        }
    });

    fastify.post('/api/brands', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...brandSchema }, async (request, reply) => {
        try {
            const { name } = request.body;
            const newBrand = new Brand({ name });
            await newBrand.save();

            // --- NEW: Real-Time POS Notification ---
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'BRAND_ADDED', brandId: newBrand._id });

            return { success: true, message: 'Brand added', data: newBrand };
        } catch (error) {
            if (error.code === 11000) return reply.status(400).send({ success: false, message: 'Brand already exists' });
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating brand' });
        }
    });
}

module.exports = brandRoutes;
