/* services/authService.js */

const User = require('../models/User');
const crypto = require('crypto');
const AppError = require('../utils/AppError'); 
const auditService = require('./auditService'); 
const securityService = require('./securityService'); 

exports.setupDefaultAdmin = async (envSetupKey, queryKey, isProduction) => {
    if (isProduction) throw new AppError('Forbidden: Setup route disabled in production.', 403);

    if (envSetupKey) {
        const providedKey = Buffer.from(queryKey || '');
        const actualKey = Buffer.from(envSetupKey);
        if (providedKey.length !== actualKey.length || !crypto.timingSafeEqual(providedKey, actualKey)) {
            throw new AppError('Forbidden: Invalid Setup Key', 403);
        }
    }

    const defaultPin = process.env.DEFAULT_ADMIN_PIN || '1234';
    const hashedPin = await securityService.hashPassword(defaultPin);
    let admin = await User.findOne({ role: 'Admin' });
    
    if (!admin) {
        admin = new User({ name: 'Super Admin', username: 'admin', pin: hashedPin, role: 'Admin', isActive: true });
        await admin.save();
        return { message: `Default Admin created. Username: 'admin', PIN: '${defaultPin}'` };
    } else {
        admin.pin = hashedPin;
        admin.username = 'admin'; 
        admin.isActive = true;
        admin.tokenVersion = (admin.tokenVersion || 0) + 1;
        await admin.save();
        return { message: `Existing Admin FORCE RESET. All old sessions revoked. Username: 'admin', PIN: '${defaultPin}'` };
    }
};

exports.authenticateUser = async (username, pin, ip, server) => {
    const safeUsername = username.trim(); 
    const user = await User.findOne({ $or: [{ username: safeUsername }, { name: safeUsername }] })
                           .collation({ locale: 'en', strength: 2 }); 
    
    if (!user) {
        await auditService.logEvent({
            action: 'FAILED_LOGIN_ATTEMPT', targetType: 'Auth', targetId: 'Login',
            username: safeUsername || 'Unknown', details: { ip, reason: 'User not found' },
            logError: server.log.error.bind(server.log)
        });
        throw new AppError('Invalid Username or PIN.', 401, { safeUsername, reason: 'User not found' });
    }

    if (user.isLocked) {
        await auditService.logEvent({
            action: 'FAILED_LOGIN_ATTEMPT', targetType: 'Auth', targetId: user._id.toString(),
            username: user.username, details: { ip, reason: 'Account locked' },
            logError: server.log.error.bind(server.log)
        });
        throw new AppError('Account locked due to too many failed attempts. Try again in 15 minutes.', 403, { user, reason: 'Account locked' });
    }
    
    const isHashed = user.pin.startsWith('$2a$') || user.pin.startsWith('$2b$');
    let isValid = false;

    if (isHashed) {
        isValid = await securityService.comparePassword(pin, user.pin);
    } else {
        if (user.pin === pin) {
            isValid = true;
            user.pin = await securityService.hashPassword(pin);
        }
    }

    if (!isValid) {
        user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
        if (user.failedLoginAttempts >= 5) user.lockUntil = Date.now() + 15 * 60 * 1000; 
        await user.save();
        
        await auditService.logEvent({
            action: 'FAILED_LOGIN_ATTEMPT', targetType: 'Auth', targetId: user._id.toString(),
            username: user.username, details: { ip, reason: 'Invalid PIN' },
            logError: server.log.error.bind(server.log)
        });

        throw new AppError('Invalid Username or PIN.', 401, { user, reason: 'Invalid PIN' });
    }
    
    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    await user.save();

    await auditService.logEvent({
        action: 'SUCCESSFUL_LOGIN', targetType: 'Auth', targetId: user._id.toString(),
        username: user.username, userId: user._id, details: { role: user.role, ip },
        logError: server.log.error.bind(server.log)
    });

    const tokens = securityService.generateTokens(server, user);
    return { user, ...tokens };
};

exports.refreshSession = async (decodedId, decodedVersion, server) => {
    const user = await User.findById(decodedId);
    if (!user || !user.isActive || user.tokenVersion !== decodedVersion) {
        throw new AppError('Invalid or revoked session', 401);
    }
    const tokens = securityService.generateTokens(server, user);
    return { user, token: tokens.token };
};

exports.revokeSession = async (userId, server) => {
    const user = await User.findById(userId);
    if (user) {
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();
        
        await auditService.logEvent({
            action: 'LOGOUT', targetType: 'Auth', targetId: user._id.toString(),
            username: user.username, userId: user._id,
            logError: server.log.error.bind(server.log)
        });
    }
    return user;
};

exports.getUserById = async (id) => {
    return await User.findOne({ _id: id });
};
