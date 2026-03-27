/* routes/staffRoutes.js */

const User = require('../models/User');
const bcrypt = require('bcrypt');

async function staffRoutes(fastify, options) {
    
    // --- PHASE 3: NEW STAFF CREATION ROUTE ---
    fastify.post('/api/auth/register', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const { name, username, pin, role } = request.body;
            if (!name || !username || !pin) return reply.status(400).send({ success: false, message: 'Missing required fields.' });

            const existingUser = await User.findOne({ username: username.trim() });
            if (existingUser) return reply.status(400).send({ success: false, message: 'Username already exists.' });

            const hashedPin = await bcrypt.hash(pin.toString(), 10);
            
            const newUser = new User({
                name: name.trim(),
                username: username.trim(),
                pin: hashedPin,
                role: role || 'Cashier',
                isActive: true
            });

            await newUser.save();
            return { success: true, message: 'User created successfully.', data: { name: newUser.name, username: newUser.username, role: newUser.role } };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error during user creation.' });
        }
    });

    // --- PHASE 3: FETCH STAFF DIRECTORY ---
    fastify.get('/api/users/staff', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const staff = await User.find({ isActive: true }).select('-pin -tokenVersion -lockUntil -failedLoginAttempts').lean();
            return { success: true, data: staff };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching staff.' });
        }
    });
}

module.exports = staffRoutes;
