/* routes/authRoutes.js */

const User = require('../models/User');
const bcrypt = require('bcrypt'); 
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

const setupRateLimit = {
    config: {
        rateLimit: {
            max: 3,
            timeWindow: '60 minutes'
        }
    }
};

async function authRoutes(fastify, options) {
    
    fastify.get('/api/auth/setup', setupRateLimit, async (request, reply) => {
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

            const defaultPin = process.env.DEFAULT_ADMIN_PIN || '1234';
            const hashedPin = await bcrypt.hash(defaultPin, 10);
            let admin = await User.findOne({ role: 'Admin' });
            
            if (!admin) {
                admin = new User({ name: 'Super Admin', username: 'admin', pin: hashedPin, role: 'Admin', isActive: true });
                await admin.save();
                return { success: true, message: `Default Admin created. Username: 'admin', PIN: '${defaultPin}'` };
            } else {
                admin.pin = hashedPin;
                admin.username = 'admin'; 
                admin.isActive = true;
                admin.tokenVersion = (admin.tokenVersion || 0) + 1;
                await admin.save();
                return { success: true, message: `Existing Admin FORCE RESET. All old sessions revoked. Username: 'admin', PIN: '${defaultPin}'` };
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

            if (!isValid) {
                user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
                if (user.failedLoginAttempts >= 5) {
                    user.lockUntil = Date.now() + 15 * 60 * 1000; 
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
            
            user.failedLoginAttempts = 0;
            user.lockUntil = undefined;
            await user.save();

            const refreshToken = fastify.jwt.sign({ 
                id: user._id, 
                tokenVersion: user.tokenVersion || 0 
            }, { expiresIn: '7d' });

            reply.setCookie('refreshToken', refreshToken, {
                path: '/',
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 7 * 24 * 60 * 60 
            });

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

    fastify.post('/api/auth/refresh', async (request, reply) => {
        try {
            const refreshToken = request.cookies.refreshToken;
            if (!refreshToken) {
                return reply.status(401).send({ success: false, message: 'No refresh token provided' });
            }

            const decoded = fastify.jwt.verify(refreshToken);
            const user = await User.findById(decoded.id);

            if (!user || !user.isActive || user.tokenVersion !== decoded.tokenVersion) {
                reply.clearCookie('refreshToken', { path: '/' });
                return reply.status(401).send({ success: false, message: 'Invalid or revoked session' });
            }

            const newToken = fastify.jwt.sign({ 
                id: user._id, 
                role: user.role, 
                username: user.username,
                tokenVersion: user.tokenVersion || 0 
            }, { expiresIn: '7d' });

            return { success: true, token: newToken, data: user };
        } catch (error) {
            reply.clearCookie('refreshToken', { path: '/' });
            reply.status(401).send({ success: false, message: 'Session expired. Please log in again.' });
        }
    });

    fastify.post('/api/auth/logout', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            const user = await User.findById(request.user.id);
            if (user) {
                user.tokenVersion = (user.tokenVersion || 0) + 1;
                await user.save();
                
                await AuditLog.create({ 
                    userId: user._id, 
                    username: user.username, 
                    action: 'LOGOUT', 
                    targetType: 'Auth', 
                    targetId: user._id.toString()
                }).catch(e => fastify.log.error('AuditLog Error:', e));
            }

            reply.clearCookie('refreshToken', { path: '/' });
            return { success: true, message: 'Logged out successfully globally.' };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error during logout' });
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

module.exports = authRoutes;
