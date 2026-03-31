/* services/authService.js */

const User = require('../models/User');
const bcrypt = require('bcrypt'); 
const crypto = require('crypto');
const AuditLog = require('../models/AuditLog'); 
const AppError = require('../utils/AppError'); // NEW IMPORT

exports.logEvent = async (action, targetId, username, details = {}, userId = null, logError) => {
    const logEntry = { action, targetType: 'Auth', targetId, username: username || 'Unknown' };
    if (Object.keys(details).length > 0) logEntry.details = details;
    if (userId) logEntry.userId = userId;
    await AuditLog.create(logEntry).catch(e => logError ? logError('AuditLog Error:', e) : console.error(e));
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
    const hashedPin = await bcrypt.hash(defaultPin, 10);
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

exports.authenticateUser = async (username, pin, ip) => {
    const safeUsername = username.trim(); 
    const user = await User.findOne({ $or: [{ username: safeUsername }, { name: safeUsername }] })
                           .collation({ locale: 'en', strength: 2 }); 
    
    if (!user) throw new AppError('Invalid Username or PIN.', 401, { safeUsername, reason: 'User not found' });

    if (user.isLocked) {
        throw new AppError('Account locked due to too many failed attempts. Try again in 15 minutes.', 403, { user, reason: 'Account locked' });
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
        if (user.failedLoginAttempts >= 5) user.lockUntil = Date.now() + 15 * 60 * 1000; 
        await user.save();
        throw new AppError('Invalid Username or PIN.', 401, { user, reason: 'Invalid PIN' });
    }
    
    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    await user.save();
    return user;
};

exports.validateRefreshToken = async (decodedId, decodedVersion) => {
    const user = await User.findById(decodedId);
    if (!user || !user.isActive || user.tokenVersion !== decodedVersion) {
        throw new AppError('Invalid or revoked session', 401);
    }
    return user;
};

exports.revokeSession = async (userId) => {
    const user = await User.findById(userId);
    if (user) {
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();
    }
    return user;
};

exports.getUserById = async (id) => {
    return await User.findOne({ _id: id });
};
