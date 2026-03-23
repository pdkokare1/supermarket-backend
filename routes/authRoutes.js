const User = require('../models/User');
const bcrypt = require('bcryptjs');

async function authRoutes(fastify, options) {
    
    // Quick setup route to create the default Admin if the database is empty
    fastify.get('/api/auth/setup', async (request, reply) => {
        try {
            const adminExists = await User.findOne({ role: 'Admin' });
            if (!adminExists) {
                const hashedPin = await bcrypt.hash('1234', 10);
                const newAdmin = new User({ name: 'Super Admin', pin: hashedPin, role: 'Admin' });
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

            // Find all active users (since PIN is unique, we must find all and compare)
            // For a system with pins, we check the unhashed ones for migration, or compare hashes.
            const users = await User.find({ isActive: true });
            let matchedUser = null;

            for (let user of users) {
                const isHashed = user.pin.startsWith('$2a$') || user.pin.startsWith('$2b$');
                
                if (isHashed) {
                    const isValid = await bcrypt.compare(pin, user.pin);
                    if (isValid) {
                        matchedUser = user;
                        break;
                    }
                } else {
                    // MIGRATION FALLBACK: If user still has plaintext PIN in DB
                    if (user.pin === pin) {
                        matchedUser = user;
                        // Silently hash and save for future security
                        matchedUser.pin = await bcrypt.hash(pin, 10);
                        await matchedUser.save();
                        break;
                    }
                }
            }
            
            if (!matchedUser) {
                return reply.status(401).send({ success: false, message: 'Invalid PIN.' });
            }
            
            return { success: true, message: 'Login successful', data: matchedUser };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error during login' });
        }
    });

    fastify.get('/api/auth/verify', async (request, reply) => {
        try {
            const { id } = request.query;
            
            if (!id) return reply.status(400).send({ success: false, message: 'User ID is required' });

            const user = await User.findOne({ _id: id, isActive: true });
            
            if (!user) {
                return reply.status(401).send({ success: false, message: 'Invalid or inactive session.' });
            }
            
            return { success: true, message: 'Session verified', data: user };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error during verification' });
        }
    });

}

module.exports = authRoutes;
