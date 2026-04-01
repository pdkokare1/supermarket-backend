/* controllers/authController.js */

const authService = require('../services/authService');
const { handleControllerError } = require('../utils/errorUtils'); 

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.setupAdmin = async (request, reply) => {
    try {
        const result = await authService.setupDefaultAdmin(process.env.SETUP_KEY, request.query.key, process.env.NODE_ENV === 'production');
        return { success: true, message: result.message };
    } catch (error) {
        handleControllerError(request, reply, error, 'Auth Setup');
    }
};

exports.login = async (request, reply) => {
    try {
        const { username, pin } = request.body;
        
        // Service now handles auth logic, token generation, and audit logging
        const { user, token, refreshToken } = await authService.authenticateUser(username, pin, request.ip, request.server);

        reply.setCookie('refreshToken', refreshToken, {
            path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 
        });
        
        return { success: true, message: 'Login successful', data: user, token: token };
        
    } catch (error) {
        if (error.status || error.statusCode) {
            return reply.status(error.status || error.statusCode).send({ success: false, message: error.message });
        }
        request.server.log.error(error);
        reply.status(500).send({ success: false, message: 'Server Error during login' });
    }
};

exports.refresh = async (request, reply) => {
    try {
        const currentRefreshToken = request.cookies.refreshToken;
        if (!currentRefreshToken) return reply.status(401).send({ success: false, message: 'No refresh token provided' });

        const decoded = request.server.jwt.verify(currentRefreshToken);
        
        // Service handles validation and new token generation
        const { user, token } = await authService.refreshSession(decoded.id, decoded.tokenVersion, request.server);

        return { success: true, token: token, data: user };
    } catch (error) {
        reply.clearCookie('refreshToken', { path: '/' });
        reply.status(401).send({ success: false, message: error.message || 'Session expired. Please log in again.' });
    }
};

exports.logout = async (request, reply) => {
    try {
        await authService.revokeSession(request.user.id, request.server);

        reply.clearCookie('refreshToken', { path: '/' });
        return { success: true, message: 'Logged out successfully globally.' };
    } catch (error) {
        handleControllerError(request, reply, error, 'Auth Logout');
    }
};

exports.verify = async (request, reply) => {
    try {
        const user = await authService.getUserById(request.query.id);
        if (!user) return reply.status(401).send({ success: false, message: 'Invalid or inactive session.' });
        
        return { success: true, message: 'Session verified', data: user };
    } catch (error) {
        handleControllerError(request, reply, error, 'Auth Verification');
    }
};
