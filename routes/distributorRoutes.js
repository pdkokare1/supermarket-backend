const Distributor = require('../models/Distributor');

const distributorSchema = {
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

async function distributorRoutes(fastify, options) {
    fastify.get('/api/distributors', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            const distributors = await Distributor.find().sort({ name: 1 });
            return { success: true, count: distributors.length, data: distributors };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching distributors' });
        }
    });

    fastify.post('/api/distributors', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...distributorSchema }, async (request, reply) => {
        try {
            const { name } = request.body;
            const newDistributor = new Distributor({ name });
            await newDistributor.save();
            return { success: true, message: 'Distributor added', data: newDistributor };
        } catch (error) {
            if (error.code === 11000) return reply.status(400).send({ success: false, message: 'Distributor already exists' });
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating distributor' });
        }
    });
}

module.exports = distributorRoutes;
