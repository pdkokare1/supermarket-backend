/* controllers/authController.js */

const User = require('../models/User');
const bcrypt = require('bcrypt'); 
const crypto = require('crypto');
const AuditLog = require('../models/AuditLog'); 

// ==========================================
// --- NEW HELPER FUNCTIONS (OPTIMIZATION) ---
// ==========================================

// --- OPTIMIZATION: Centralized Audit Logging ---
const logAuthEvent = async (request, action, targetId, username, details = {}, userId = null) => {
    const logEntry = {
        action,
        targetType: 'Auth',
        targetId,
        username: username || 'Unknown'
    };
    
    if (Object.keys(details).length > 0) logEntry.details = details;
    if (userId) logEntry.userId = userId;

    await AuditLog.create(logEntry).catch(e => request.server.log.error('AuditLog Error:', e));
};

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.setupAdmin = async (request, reply) => {
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
        request.server.log.error(error);
        reply.status(500).send({ success: false, message: 'Server Error' });
    }
};

exports.login = async (request, reply) => {
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
            await logAuthEvent(request, 'FAILED_LOGIN_ATTEMPT', 'Login', safeUsername, { ip: request.ip, reason: 'User not found' });
            return reply.status(401).send({ success: false, message: 'Invalid Username or PIN.' });
        }

        if (user.isLocked) {
            await logAuthEvent(request, 'FAILED_LOGIN_ATTEMPT', user._id.toString(), user.username, { ip: request.ip, reason: 'Account locked' });
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

            await logAuthEvent(request, 'FAILED_LOGIN_ATTEMPT', user._id.toString(), user.username, { ip: request.ip, reason: 'Invalid PIN' });
            return reply.status(401).send({ success: false, message: 'Invalid Username or PIN.' });
        }
        
        user.failedLoginAttempts = 0;
        user.lockUntil = undefined;
        await user.save();

        const refreshToken = request.server.jwt.sign({ 
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

        const token = request.server.jwt.sign({ 
            id: user._id, 
            role: user.role, 
            username: user.username,
            tokenVersion: user.tokenVersion || 0 
        }, { expiresIn: '7d' }); 
        
        await logAuthEvent(request, 'SUCCESSFUL_LOGIN', user._id.toString(), user.username, { role: user.role, ip: request.ip }, user._id);

        return { success: true, message: 'Login successful', data: user, token: token };
        
    } catch (error) {
        request.server.log.error(error);
        reply.status(500).send({ success: false, message: 'Server Error during login' });
    }
};

exports.refresh = async (request, reply) => {
    try {
        const refreshToken = request.cookies.refreshToken;
        if (!refreshToken) {
            return reply.status(401).send({ success: false, message: 'No refresh token provided' });
        }

        const decoded = request.server.jwt.verify(refreshToken);
        const user = await User.findById(decoded.id);

        if (!user || !user.isActive || user.tokenVersion !== decoded.tokenVersion) {
            reply.clearCookie('refreshToken', { path: '/' });
            return reply.status(401).send({ success: false, message: 'Invalid or revoked session' });
        }

        const newToken = request.server.jwt.sign({ 
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
};

exports.logout = async (request, reply) => {
    try {
        const user = await User.findById(request.user.id);
        if (user) {
            user.tokenVersion = (user.tokenVersion || 0) + 1;
            await user.save();
            
            await logAuthEvent(request, 'LOGOUT', user._id.toString(), user.username, {}, user._id);
        }

        reply.clearCookie('refreshToken', { path: '/' });
        return { success: true, message: 'Logged out successfully globally.' };
    } catch (error) {
        request.server.log.error(error);
        reply.status(500).send({ success: false, message: 'Server Error during logout' });
    }
};

exports.verify = async (request, reply) => {
    try {
        const { id } = request.query;
        const user = await User.findOne({ _id: id });
        
        if (!user) {
            return reply.status(401).send({ success: false, message: 'Invalid or inactive session.' });
        }
        return { success: true, message: 'Session verified', data: user };
    } catch (error) {
        request.server.log.error(error);
        reply.status(500).send({ success: false, message: 'Server Error during verification' });
    }
};
