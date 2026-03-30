/* controllers/authController.js */

const authService = require('../services/authService');
const User = require('../models/User');

exports.setupAdmin = async (request, reply) => {
    try {
        const result = await authService.setupDefaultAdmin(process.env.SETUP_KEY, request.query.key, process.env.NODE_ENV === 'production');
        return { success: true, message: result.message };
    } catch (error) {
        if (error.status) return reply.status(error.status).send({ success: false, message: error.message });
        request.server.log.error(error);
        reply.status(500).send({ success: false, message: 'Server Error' });
    }
};

exports.login = async (request, reply) => {
    try {
        const { username, pin } = request.body;
        
        const user = await authService.authenticateUser(username, pin, request.ip);

        const refreshToken = request.server.jwt.sign(
            { id: user._id, tokenVersion: user.tokenVersion || 0 }, 
            { expiresIn: '7d' }
        );

        reply.setCookie('refreshToken', refreshToken, {
            path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 
        });

        const token = request.server.jwt.sign(
            { id: user._id, role: user.role, username: user.username, tokenVersion: user.tokenVersion || 0 }, 
            { expiresIn: '7d' }
        ); 
        
        await authService.logEvent('SUCCESSFUL_LOGIN', user._id.toString(), user.username, { role: user.role, ip: request.ip }, user._id, request.server.log.error.bind(request.server.log));

        return { success: true, message: 'Login successful', data: user, token: token };
        
    } catch (error) {
        if (error.status) {
            const targetId = error.user ? error.user._id.toString() : 'Login';
            const uname = error.user ? error.user.username : (error.safeUsername || 'Unknown');
            await authService.logEvent('FAILED_LOGIN_ATTEMPT', targetId, uname, { ip: request.ip, reason: error.reason }, null, request.server.log.error.bind(request.server.log));
            return reply.status(error.status).send({ success: false, message: error.message });
        }
        request.server.log.error(error);
        reply.status(500).send({ success: false, message: 'Server Error during login' });
    }
};

exports.refresh = async (request, reply) => {
    try {
        const refreshToken = request.cookies.refreshToken;
        if (!refreshToken) return reply.status(401).send({ success: false, message: 'No refresh token provided' });

        const decoded = request.server.jwt.verify(refreshToken);
        const user = await authService.validateRefreshToken(decoded.id, decoded.tokenVersion);

        const newToken = request.server.jwt.sign(
            { id: user._id, role: user.role, username: user.username, tokenVersion: user.tokenVersion || 0 }, 
            { expiresIn: '7d' }
        );

        return { success: true, token: newToken, data: user };
    } catch (error) {
        reply.clearCookie('refreshToken', { path: '/' });
        reply.status(401).send({ success: false, message: error.message || 'Session expired. Please log in again.' });
    }
};

exports.logout = async (request, reply) => {
    try {
        const user = await authService.revokeSession(request.user.id);
        if (user) {
            await authService.logEvent('LOGOUT', user._id.toString(), user.username, {}, user._id, request.server.log.error.bind(request.server.log));
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
        const user = await User.findOne({ _id: request.query.id });
        if (!user) return reply.status(401).send({ success: false, message: 'Invalid or inactive session.' });
        
        return { success: true, message: 'Session verified', data: user };
    } catch (error) {
        request.server.log.error(error);
        reply.status(500).send({ success: false, message: 'Server Error during verification' });
    }
};
