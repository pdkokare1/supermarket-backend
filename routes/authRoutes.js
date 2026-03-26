const User = require('../models/User');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const AuditLog = require('../models/AuditLog'); 

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

const verifySchema = {
    schema: {
        querystring: {
            type: 'object',
            required: ['id'],
            properties: {
                id: { type: 'string' }
            }
        }
    }
};

async function authRoutes(fastify, options) {
    
    fastify.get('/api/auth/setup', async (request, reply) => {
        try {
            if (process.env.NODE_ENV === 'production') {
                return reply.status(403).send({ success: false, message: 'Forbidden: Setup route disabled in production.' });
            }

            if (process.env.SETUP_KEY) {
                const providedKey = Buffer.from(request.query.key || '');
                const actualKey = Buffer.from(process.env.SETUP_KEY);
                
                if (providedKey.length !== actualKey.length || !crypto.timingSafeEqual(providedKey, actualKey)) {
                    return reply.status(403).send({ success: false, message: 'Forbidden: Invalid Setup Key' });
                }
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
            const safeUsername = username.trim(); 

            const user = await User.findOne({ 
                $or: [
                    { username: safeUsername }, 
                    { name: safeUsername }
                ]
            }).collation({ locale: 'en', strength: 2 }); 
            
            if (!user) {
                await AuditLog.create({ 
                    action: 'FAILED_LOGIN_ATTEMPT', 
                    targetType: 'Auth', 
                    targetId: 'Login', 
                    username: safeUsername || 'Unknown', 
                    details: { ip: request.ip, reason: 'User not found' } 
                }).catch(e => fastify.log.error('AuditLog Error:', e));

                return reply.status(401).send({ success: false, message: 'Invalid Username or PIN.' });
            }

            // --- NEW: Account Lockout Check ---
            if (user.isLocked) {
                await AuditLog.create({ 
                    action: 'FAILED_LOGIN_ATTEMPT', 
                    targetType: 'Auth', 
                    targetId: user._id.toString(), 
                    username: user.username, 
                    details: { ip: request.ip, reason: 'Account locked' } 
                }).catch(e => fastify.log.error('AuditLog Error:', e));

                return reply.status(403).send({ 
                    success: false, 
                    message: 'Account locked due to too many failed attempts. Try again in 15 minutes.' 
                });
            }
            
            const isHashed = user.pin.startsWith('$2a$') || user.pin.startsWith('$2b$');
            let isValid = false;

            if (isHashed) {
                isValid = await bcrypt.compare(pin, user.pin);
            } else {
                if (user.pin === pin) {
                    isValid = true;
                    user.pin = await bcrypt.hash(pin, 10);
                }
            }

            // --- NEW: Handle Failed Attempt & Lockout Logic ---
            if (!isValid) {
                user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
                if (user.failedLoginAttempts >= 5) {
                    user.lockUntil = Date.now() + 15 * 60 * 1000; // Lock for 15 minutes
                }
                await user.save();

                await AuditLog.create({ 
                    action: 'FAILED_LOGIN_ATTEMPT', 
                    targetType: 'Auth', 
                    targetId: user._id.toString(), 
                    username: user.username, 
                    details: { ip: request.ip, reason: 'Invalid PIN' } 
                }).catch(e => fastify.log.error('AuditLog Error:', e));

                return reply.status(401).send({ success: false, message: 'Invalid Username or PIN.' });
            }
            
            // --- NEW: Reset Failed Attempts on Success ---
            user.failedLoginAttempts = 0;
            user.lockUntil = undefined;
            await user.save();

            // --- NEW: Refresh Token Infrastructure (Cookie) ---
            const refreshToken = fastify.jwt.sign({ 
                id: user._id, 
                tokenVersion: user.tokenVersion || 0 
            }, { expiresIn: '7d' });

            reply.setCookie('refreshToken', refreshToken, {
                path: '/',
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 7 * 24 * 60 * 60 // 7 days in seconds
            });

            // Retaining the original token structure to prevent frontend breakage
            const token = fastify.jwt.sign({ 
                id: user._id, 
                role: user.role, 
                username: user.username,
                tokenVersion: user.tokenVersion || 0 
            }, { expiresIn: '7d' }); 
            
            await AuditLog.create({ 
                userId: user._id, 
                username: user.username, 
                action: 'SUCCESSFUL_LOGIN', 
                targetType: 'Auth', 
                targetId: user._id.toString(), 
                details: { role: user.role, ip: request.ip } 
            }).catch(e => fastify.log.error('AuditLog Error:', e));

            return { success: true, message: 'Login successful', data: user, token: token };
            
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error during login' });
        }
    });

    fastify.get('/api/auth/verify', { schema: verifySchema.schema, preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            const { id } = request.query;
            
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
