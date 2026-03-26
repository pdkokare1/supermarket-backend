const Store = require('../models/Store');

async function storeRoutes(fastify, options) {
    // PUBLIC: Get all stores (Needed for login dropdowns)
    fastify.get('/api/stores', async (request, reply) => {
        try {
            const stores = await Store.find({ isActive: true }).sort({ name: 1 });
            return { success: true, data: stores };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching stores' });
        }
    });

    // ADMIN ONLY: Create a new store
    fastify.post('/api/stores', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const { name, location, contactNumber } = request.body;
            
            if (!name || !location) {
                return reply.status(400).send({ success: false, message: 'Store Name and Location are required' });
            }

            const newStore = new Store({ name, location, contactNumber: contactNumber || '' });
            await newStore.save();
            
            return { success: true, message: 'Store created successfully', data: newStore };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating store' });
        }
    });
}

module.exports = storeRoutes;
