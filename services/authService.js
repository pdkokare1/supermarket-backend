/* services/authService.js */

const User = require('../models/User');
const crypto = require('crypto');
const AppError = require('../utils/AppError'); 
const auditService = require('./auditService'); 
const securityService = require('./securityService'); 
const cacheUtils = require('../utils/cacheUtils');

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

const executeLockoutPipeline = async (redis, ip, safeUsername, ipFails, userFails) => {
    if (!redis) return;
    try {
        const pipeline = redis.multi();
        pipeline.incr(`lockout:ip:${ip}`);
        pipeline.incr(`lockout:user:${safeUsername}`);
        pipeline.expire(`lockout:ip:${ip}`, 1800, 'NX');
        pipeline.expire(`lockout:user:${safeUsername}`, 900, 'NX');
        await pipeline.exec();
    } catch (err) {
        // Soft fail to ensure login process isn't completely halted by cache issues
    }
};

exports.setupDefaultAdmin = async (envSetupKey, queryKey, isProduction) => {
    if (isProduction) throw new AppError('Forbidden: Setup route disabled in production.', 403);

    if (envSetupKey) {
        const providedKey = Buffer.from(queryKey || '', 'utf8');
        const actualKey = Buffer.from(envSetupKey, 'utf8');
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
        
        const redis = cacheUtils.getClient();
        if (redis) {
            try { await redis.del(`cache:user:${admin._id.toString()}`); } catch (e) {}
        }

        return { message: `Existing Admin FORCE RESET. All old sessions revoked. Username: 'admin', PIN: '${defaultPin}'` };
    }
};

exports.authenticateUser = async (username, pin, ip, server) => {
    const redis = cacheUtils.getClient();
    const safeUsername = username.trim(); 
    let ipFails = 0;
    let userFails = 0;

    if (redis) {
        try {
            ipFails = await redis.get(`lockout:ip:${ip}`);
            userFails = await redis.get(`lockout:user:${safeUsername}`);
        } catch (e) {
            // Soft fail: continue to DB if Redis is unreachable
        }

        if (ipFails && parseInt(ipFails, 10) > 10) {
            await logAuthAudit(server, 'EDGE_THREAT_BLOCKED', 'IP', ip, { reason: 'IP brute-force block triggered' });
            throw new AppError('Too many failed requests from this IP. Blocked globally for 30 minutes.', 403);
        }
        if (userFails && parseInt(userFails, 10) > 10) {
            await logAuthAudit(server, 'EDGE_THREAT_BLOCKED', 'Username', safeUsername, { ip, reason: 'Distributed account brute-force block' });
            throw new AppError('Too many failed requests for this account. Blocked for 15 minutes.', 403);
        }
    }

    // ENTERPRISE FIX: Removed highly expensive .collation() on $or array which triggers Full Collection Scans.
    // Ensure DB schemas have normalized lowercase usernames for scalable lookups.
    const user = await User.findOne({ $or: [{ username: safeUsername }, { name: safeUsername }] }); 
    
    if (!user) {
        await executeLockoutPipeline(redis, ip, safeUsername, ipFails, userFails);
        
        // ENTERPRISE FIX: Valid bcrypt hash structure ensures the compare function simulates real CPU time (~100ms) 
        // to prevent username enumeration via timing attacks. Invalid hash strings fail instantly.
        await securityService.comparePassword('dummy', '$2b$10$XmO21Z4h3q.G0n1C3oQ.ru1Z4M/5p3l.x.Q.O.Z1.L.E.M.N.O.P.Q1');
        
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
        try {
            // ENTERPRISE FIX: Enforced utf8 buffers to prevent byte mismatch on foreign/emoji characters
            const bufUserPin = Buffer.from(user.pin, 'utf8');
            const bufPin = Buffer.from(pin, 'utf8');
            if (bufUserPin.length === bufPin.length && crypto.timingSafeEqual(bufUserPin, bufPin)) {
                isValid = true;
                user.pin = await securityService.hashPassword(pin);
            }
        } catch (e) {
            isValid = false; 
        }
    }

    if (!isValid) {
        await executeLockoutPipeline(redis, ip, safeUsername, ipFails, userFails);

        user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
        if (user.failedLoginAttempts >= 5) user.lockUntil = Date.now() + 15 * 60 * 1000; 
        await user.save();
        
        await logAuthAudit(server, 'FAILED_LOGIN_ATTEMPT', user._id.toString(), user.username, { ip, reason: 'Invalid PIN' });
        throw new AppError('Invalid Username or PIN.', 401, { user, reason: 'Invalid PIN' });
    }
    
    if (redis) {
        try {
            const pipeline = redis.multi();
            pipeline.del(`lockout:ip:${ip}`);
            pipeline.del(`lockout:user:${safeUsername}`);
            pipeline.del(`cache:user:${user._id.toString()}`);
            await pipeline.exec();
        } catch (e) { }
    }
    
    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    await user.save();

    await logAuthAudit(server, 'SUCCESSFUL_LOGIN', user._id.toString(), user.username, { role: user.role, ip }, user._id);

    const tokens = securityService.generateTokens(server, user);
    return { user, ...tokens };
};

exports.refreshSession = async (decodedId, decodedVersion, server) => {
    const user = await exports.getUserById(decodedId);
    
    if (!user || !user.isActive || user.isLocked || user.tokenVersion !== decodedVersion) {
        throw new AppError('Invalid, locked, or revoked session', 401);
    }
    const tokens = securityService.generateTokens(server, user);
    return { user, token: tokens.token, refreshToken: tokens.refreshToken };
};

exports.revokeSession = async (userId, server, tokenToBlacklist = null) => {
    const user = await User.findById(userId);
    if (user) {
        user.tokenVersion = (user.tokenVersion || 0) + 1; 
        await user.save();
        
        const redis = cacheUtils.getClient();
        if (redis) {
            try {
                await redis.del(`cache:user:${userId.toString()}`);
                
                if (tokenToBlacklist) {
                    const decoded = server.jwt.decode(tokenToBlacklist);
                    if (decoded && decoded.exp) {
                        const ttl = decoded.exp - Math.floor(Date.now() / 1000);
                        if (ttl > 0) {
                            await redis.set(`bl_${tokenToBlacklist}`, 'blacklisted', 'EX', ttl);
                        }
                    }
                }
            } catch (err) {
                server.log.warn(`Failed to process Redis blacklisting during logout: ${err.message}`);
            }
        }

        await logAuthAudit(server, 'LOGOUT', user._id.toString(), user.username, {}, user._id);
    }
    return user;
};

exports.getUserById = async (id) => {
    const redis = cacheUtils.getClient();
    const cacheKey = `cache:user:${id}`;
    
    if (redis) {
        try {
            const cachedUser = await redis.get(cacheKey);
            if (cachedUser) return JSON.parse(cachedUser);
        } catch (err) {
            // Soft fail, allow system to fetch directly from DB
        }
    }

    const user = await User.findById(id).lean();
    
    if (redis && user) {
        try {
            await redis.set(cacheKey, JSON.stringify(user), 'EX', 300);
        } catch (err) {
            // Soft fail
        }
    }
    
    return user;
};
