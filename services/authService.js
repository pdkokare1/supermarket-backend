/* services/authService.js */

const User = require('../models/User');
const crypto = require('crypto');
const AppError = require('../utils/AppError'); 
const auditService = require('./auditService'); 
const securityService = require('./securityService'); 

// MODULARITY: Standardized helper for all Auth-related audit logs
const logAuthAudit = async (server, action, targetId, username, details = {}, userId = null) => {
    await auditService.logEvent({
        action,
        targetType: 'Auth',
        targetId,
        username,
        userId,
        details,
        logError: server.log.error.bind(server.log)
    });
};

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
        await logAuthAudit(server, 'FAILED_LOGIN_ATTEMPT', 'Login', safeUsername || 'Unknown', { ip, reason: 'User not found' });
        throw new AppError('Invalid Username or PIN.', 401, { safeUsername, reason: 'User not found' });
    }

    if (user.isLocked) {
        await logAuthAudit(server, 'FAILED_LOGIN_ATTEMPT', user._id.toString(), user.username, { ip, reason: 'Account locked' });
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
        
        await logAuthAudit(server, 'FAILED_LOGIN_ATTEMPT', user._id.toString(), user.username, { ip, reason: 'Invalid PIN' });

        throw new AppError('Invalid Username or PIN.', 401, { user, reason: 'Invalid PIN' });
    }
    
    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    await user.save();

    await logAuthAudit(server, 'SUCCESSFUL_LOGIN', user._id.toString(), user.username, { role: user.role, ip }, user._id);

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
        
        await logAuthAudit(server, 'LOGOUT', user._id.toString(), user.username, {}, user._id);
    }
    return user;
};

exports.getUserById = async (id) => {
    // OPTIMIZATION: Natively faster lookup method
    return await User.findById(id);
};
