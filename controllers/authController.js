/* controllers/authController.js */

const authService = require('../services/authService');

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.setupAdmin = async (request, reply) => {
    const result = await authService.setupDefaultAdmin(process.env.SETUP_KEY, request.query.key, process.env.NODE_ENV === 'production');
    return { success: true, message: result.message };
};

exports.login = async (request, reply) => {
    const { username, pin } = request.body;
    
    try {
        const { user, token, refreshToken } = await authService.authenticateUser(username, pin, request.ip, request.server);

        // OPTIMIZATION: Lock cookie to domain via __Host- prefix in production
        const cookieName = process.env.NODE_ENV === 'production' ? '__Host-refreshToken' : 'refreshToken';

        reply.setCookie(cookieName, refreshToken, {
            path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 
        });
        
        return { success: true, message: 'Login successful', data: user, token: token };
    } catch (error) {
        // OPTIMIZATION: Uniform response for login failures to prevent timing and enumeration attacks
        return reply.status(401).send({ success: false, message: 'Invalid credentials or inactive account.' });
    }
};

exports.refresh = async (request, reply) => {
    // Check for enterprise Host-locked cookie first, fallback to legacy name during transition
    const legacyCookieName = 'refreshToken';
    const secureCookieName = '__Host-refreshToken';
    const currentRefreshToken = request.cookies[secureCookieName] || request.cookies[legacyCookieName];
    
    if (!currentRefreshToken) return reply.status(401).send({ success: false, message: 'No refresh token provided' });

    try {
        const decoded = request.server.jwt.verify(currentRefreshToken);
        
        // OPTIMIZATION: Extract the newly rotated refresh token alongside the standard token
        const { user, token, refreshToken } = await authService.refreshSession(decoded.id, decoded.tokenVersion, request.server);

        // OPTIMIZATION: Perform explicit Refresh Token Rotation mapping to the cookie
        if (refreshToken) {
            const cookieName = process.env.NODE_ENV === 'production' ? secureCookieName : legacyCookieName;
            
            reply.setCookie(cookieName, refreshToken, {
                path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 
            });
        }

        return { success: true, token: token, data: user };
    } catch (error) {
        // OPTIMIZATION: Catch bad signatures securely
        return reply.status(401).send({ success: false, message: 'Invalid or expired refresh token.' });
    }
};

exports.logout = async (request, reply) => {
    await authService.revokeSession(request.user.id, request.server);

    // OPTIMIZATION: Extract current access token and blacklist it in Redis to immediately kill active in-memory sessions
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ') && request.server.redis) {
        const token = authHeader.split(' ')[1];
        try {
            const decoded = request.server.jwt.decode(token);
            if (decoded && decoded.exp) {
                const ttl = decoded.exp - Math.floor(Date.now() / 1000);
                if (ttl > 0) {
                    await request.server.redis.set(`bl_${token}`, 'blacklisted', 'EX', ttl);
                }
            }
        } catch (err) {
            request.server.log.warn(`Failed to blacklist token during logout: ${err.message}`);
        }
    }

    const cookieName = process.env.NODE_ENV === 'production' ? '__Host-refreshToken' : 'refreshToken';
    reply.clearCookie(cookieName, { path: '/' });
    
    // Also clear the legacy one to be absolutely certain it's wiped on old sessions
    if (process.env.NODE_ENV === 'production') {
        reply.clearCookie('refreshToken', { path: '/' });
    }

    return { success: true, message: 'Logged out successfully globally.' };
};

exports.verify = async (request, reply) => {
    const user = await authService.getUserById(request.query.id);
    if (!user) return reply.status(401).send({ success: false, message: 'Invalid or inactive session.' });
    
    return { success: true, message: 'Session verified', data: user };
};
