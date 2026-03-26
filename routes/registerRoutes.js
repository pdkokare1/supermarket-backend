const Register = require('../models/Register');

async function registerRoutes(fastify, options) {
    // PUBLIC: Get registers for a specific store (Needed for login dropdowns)
    fastify.get('/api/stores/:storeId/registers', async (request, reply) => {
        try {
            const registers = await Register.find({ storeId: request.params.storeId, isActive: true }).sort({ name: 1 });
            return { success: true, data: registers };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching registers' });
        }
    });

    // ADMIN ONLY: Create a new register/terminal
    fastify.post('/api/registers', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const { name, storeId } = request.body;
            
            if (!name || !storeId) {
                return reply.status(400).send({ success: false, message: 'Terminal Name and Store ID are required' });
            }

            const newRegister = new Register({ name, storeId });
            await newRegister.save();
            
            return { success: true, message: 'Terminal created successfully', data: newRegister };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating register' });
        }
    });
}

module.exports = registerRoutes;
