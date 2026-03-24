const User = require('../models/User');
const bcrypt = require('bcryptjs');

const loginSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['username', 'pin'],
            properties: {
                username: { type: 'string' },
                pin: { type: 'string' }
            }
        }
    },
    config: {
        rateLimit: {
            max: 5, 
            timeWindow: '15 minutes'
        }
    }
};

async function authRoutes(fastify, options) {
    
    fastify.get('/api/auth/setup', async (request, reply) => {
        try {
            if (process.env.NODE_ENV === 'production') {
                return reply.status(403).send({ success: false, message: 'Forbidden: Setup route disabled in production.' });
            }

            if (process.env.SETUP_KEY && request.query.key !== process.env.SETUP_KEY) {
                return reply.status(403).send({ success: false, message: 'Forbidden: Invalid Setup Key' });
            }

            const hashedPin = await bcrypt.hash('1234', 10);
            let admin = await User.findOne({ role: 'Admin' });
            
            if (!admin) {
                admin = new User({ name: 'Super Admin', username: 'admin', pin: hashedPin, role: 'Admin', isActive: true });
                await admin.save();
                return { success: true, message: "Default Admin created. Username: 'admin', PIN: '1234'" };
            } else {
                admin.pin = hashedPin;
                admin.username = 'admin'; 
                admin.isActive = true;
                // --- SECURITY HARDENING: Instantly revoke all active sessions on reset ---
                admin.tokenVersion = (admin.tokenVersion || 0) + 1;
                await admin.save();
                return { success: true, message: "Existing Admin FORCE RESET. All old sessions revoked. Username: 'admin', PIN: '1234'" };
            }
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error' });
        }
    });

    fastify.post('/api/auth/login', loginSchema, async (request, reply) => {
        try {
            const { username, pin } = request.body;

            const safeUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
            const user = await User.findOne({ 
                $or: [
                    { username: { $regex: new RegExp('^' + safeUsername + '$', 'i') } }, 
                    { name: { $regex: new RegExp('^' + safeUsername + '$', 'i') } }
                ]
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
            
            // --- SECURITY HARDENING: Embed tokenVersion in payload ---
            const token = fastify.jwt.sign({ 
                id: user._id, 
                role: user.role, 
                username: user.username,
                tokenVersion: user.tokenVersion || 0 
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

            const user = await User.findOne({ _id: id });
            
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
