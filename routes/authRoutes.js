const User = require('../models/User');

async function authRoutes(fastify, options) {
    
    // Quick setup route to create the default Admin if the database is empty
    fastify.get('/api/auth/setup', async (request, reply) => {
        try {
            const adminExists = await User.findOne({ role: 'Admin' });
            if (!adminExists) {
                const newAdmin = new User({ name: 'Super Admin', pin: '1234', role: 'Admin' });
                await newAdmin.save();
                return { success: true, message: 'Default Admin created. PIN: 1234' };
            }
            return { success: true, message: 'Admin already exists.' };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error' });
        }
    });

    fastify.post('/api/auth/login', async (request, reply) => {
        try {
            const { pin } = request.body;
            
            if (!pin) return reply.status(400).send({ success: false, message: 'PIN is required' });

            const user = await User.findOne({ pin: pin, isActive: true });
            
            if (!user) {
                return reply.status(401).send({ success: false, message: 'Invalid PIN.' });
            }
            
            return { success: true, message: 'Login successful', data: user };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error during login' });
        }
    });

}

module.exports = authRoutes;
