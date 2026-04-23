/* controllers/authController.js */
'use strict';

const authService = require('../services/authService');

// OPTIMIZATION: Evaluate environment constants at module load exactly once. 
// This prevents expensive `parseInt` and environment variable lookups on every single authentication request.
const isProd = process.env.NODE_ENV === 'production';
const cookieMaxAge = process.env.REFRESH_TOKEN_EXPIRES_IN ? parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN, 10) : 7 * 24 * 60 * 60;

const baseCookieOptions = {
    path: '/', 
    httpOnly: true, 
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax', 
    maxAge: cookieMaxAge 
};

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.setupAdmin = async (request, reply) => {
    // ENTERPRISE SECURITY FIX: Ensure this endpoint is strictly disabled in production unless implicitly flagged via ENV
    if (isProd && process.env.ENABLE_SETUP_ENDPOINT !== 'true') {
        return reply.status(403).send({ success: false, message: 'Setup endpoint disabled in production.' });
    }

    const result = await authService.setupDefaultAdmin(process.env.SETUP_KEY, request.query.key, false);
    return { success: true, message: result.message };
};

exports.login = async (request, reply) => {
    const { username, pin } = request.body;
    
    try {
        const { user, token, refreshToken } = await authService.authenticateUser(username, pin, request.ip, request.server);

        reply.setCookie('refreshToken', refreshToken, baseCookieOptions);
        
        return { success: true, message: 'Login successful', data: user, token: token };
    } catch (error) {
        return reply.status(401).send({ success: false, message: 'Invalid credentials or inactive account.' });
    }
};

exports.refresh = async (request, reply) => {
    const currentRefreshToken = request.cookies['refreshToken'] || request.cookies['__Host-refreshToken'];
    
    if (!currentRefreshToken) return reply.status(401).send({ success: false, message: 'No refresh token provided' });

    try {
        const decoded = request.server.jwt.verify(currentRefreshToken);
        
        const { user, token, refreshToken } = await authService.refreshSession(decoded.id, decoded.tokenVersion, request.server);

        if (refreshToken) {
            reply.setCookie('refreshToken', refreshToken, baseCookieOptions);
        }

        return { success: true, token: token, data: user };
    } catch (error) {
        return reply.status(401).send({ success: false, message: 'Invalid or expired refresh token.' });
    }
};

exports.logout = async (request, reply) => {
    let token = null;
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    }

    // Pass token to service layer to handle the Redis blacklisting securely
    await authService.revokeSession(request.user.id, request.server, token);

    reply.clearCookie('refreshToken', { path: '/', sameSite: baseCookieOptions.sameSite, secure: baseCookieOptions.secure });
    reply.clearCookie('__Host-refreshToken', { path: '/' });

    return { success: true, message: 'Logged out successfully globally.' };
};

exports.verify = async (request, reply) => {
    const user = await authService.getUserById(request.user.id);
    if (!user) return reply.status(401).send({ success: false, message: 'Invalid or inactive session.' });
    
    return { success: true, message: 'Session verified', data: user };
};
