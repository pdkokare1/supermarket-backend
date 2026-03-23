const User = require('../models/User');
const bcrypt = require('bcryptjs');

async function authRoutes(fastify, options) {
    
    fastify.get('/api/auth/setup', async (request, reply) => {
        try {
            const adminExists = await User.findOne({ role: 'Admin' });
            if (!adminExists) {
                const hashedPin = await bcrypt.hash('1234', 10);
                const newAdmin = new User({ name: 'Super Admin', username: 'admin', pin: hashedPin, role: 'Admin' });
                await newAdmin.save();
                return { success: true, message: "Default Admin created. Username: 'admin', PIN: '1234'" };
            }
            return { success: true, message: 'Admin already exists.' };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error' });
        }
    });

    // --- SECURED: Specific Rate Limiter blocks PIN brute forcing ---
    fastify.post('/api/auth/login', {
        config: {
            rateLimit: {
                max: 5, // Maximum 5 attempts
                timeWindow: '1 minute'
            }
        }
    }, async (request, reply) => {
        try {
            const { username, pin } = request.body;
            
            if (!pin) return reply.status(400).send({ success: false, message: 'PIN is required' });
            if (!username) return reply.status(400).send({ success: false, message: 'Username is required' });

            const user = await User.findOne({ 
                $or: [{ username: username }, { name: username }], 
                isActive: true 
            });
            
            if (!user) {
                return reply.status(401).send({ success: false, message: 'Invalid Username or PIN.' });
            }
            
            const isHashed = user.pin.startsWith('$2a$') || user.pin.startsWith('$2b$');
            
            if (isHashed) {
                const isValid = await bcrypt.compare(pin, user.pin);
                if (!isValid) {
                    return reply.status(401).send({ success: false, message: 'Invalid Username or PIN.' });
                }
            } else {
                if (user.pin !== pin) {
                    return reply.status(401).send({ success: false, message: 'Invalid Username or PIN.' });
                }
                user.pin = await bcrypt.hash(pin, 10);
                await user.save();
            }
            
            const token = fastify.jwt.sign({ 
                id: user._id, 
                role: user.role, 
                username: user.username 
            }, { expiresIn: '7d' }); 
            
            return { success: true, message: 'Login successful', data: user, token: token };
            
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
