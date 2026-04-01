/* controllers/authController.js */

const authService = require('../services/authService');
const auditService = require('../services/auditService'); // NEW IMPORT
const { handleControllerError } = require('../utils/errorUtils'); 

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

const generateTokens = (request, user) => {
    const tokenVersion = user.tokenVersion || 0;
    
    const refreshToken = request.server.jwt.sign(
        { id: user._id, tokenVersion }, 
        { expiresIn: '7d' }
    );

    const token = request.server.jwt.sign(
        { id: user._id, role: user.role, username: user.username, tokenVersion }, 
        { expiresIn: '7d' }
    );

    return { token, refreshToken };
};

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
        
        const user = await authService.authenticateUser(username, pin, request.ip);
        const { token, refreshToken } = generateTokens(request, user);

        reply.setCookie('refreshToken', refreshToken, {
            path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 
        });
        
        await auditService.logEvent({
            action: 'SUCCESSFUL_LOGIN',
            targetType: 'Auth',
            targetId: user._id.toString(),
            username: user.username,
            userId: user._id,
            details: { role: user.role, ip: request.ip },
            logError: request.server.log.error.bind(request.server.log)
        });

        return { success: true, message: 'Login successful', data: user, token: token };
        
    } catch (error) {
        if (error.status || error.statusCode) {
            const targetId = error.user ? error.user._id.toString() : 'Login';
            const uname = error.user ? error.user.username : (error.safeUsername || 'Unknown');
            
            await auditService.logEvent({
                action: 'FAILED_LOGIN_ATTEMPT',
                targetType: 'Auth',
                targetId: targetId,
                username: uname,
                details: { ip: request.ip, reason: error.reason },
                logError: request.server.log.error.bind(request.server.log)
            });
            
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
        const user = await authService.validateRefreshToken(decoded.id, decoded.tokenVersion);

        const { token } = generateTokens(request, user);

        return { success: true, token: token, data: user };
    } catch (error) {
        reply.clearCookie('refreshToken', { path: '/' });
        reply.status(401).send({ success: false, message: error.message || 'Session expired. Please log in again.' });
    }
};

exports.logout = async (request, reply) => {
    try {
        const user = await authService.revokeSession(request.user.id);
        if (user) {
            await auditService.logEvent({
                action: 'LOGOUT',
                targetType: 'Auth',
                targetId: user._id.toString(),
                username: user.username,
                userId: user._id,
                logError: request.server.log.error.bind(request.server.log)
            });
        }

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
