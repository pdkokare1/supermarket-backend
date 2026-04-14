/* controllers/authController.js */

const authService = require('../services/authService');
const catchAsync = require('../utils/catchAsync'); 

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.setupAdmin = catchAsync(async (request, reply) => {
    const result = await authService.setupDefaultAdmin(process.env.SETUP_KEY, request.query.key, process.env.NODE_ENV === 'production');
    return { success: true, message: result.message };
}, 'Auth Setup');

exports.login = catchAsync(async (request, reply) => {
    const { username, pin } = request.body;
    
    const { user, token, refreshToken } = await authService.authenticateUser(username, pin, request.ip, request.server);

    reply.setCookie('refreshToken', refreshToken, {
        path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 
    });
    
    return { success: true, message: 'Login successful', data: user, token: token };
}, 'Auth Login');

exports.refresh = catchAsync(async (request, reply) => {
    const currentRefreshToken = request.cookies.refreshToken;
    if (!currentRefreshToken) return reply.status(401).send({ success: false, message: 'No refresh token provided' });

    const decoded = request.server.jwt.verify(currentRefreshToken);
    
    // OPTIMIZATION: Extract the newly rotated refresh token alongside the standard token
    const { user, token, refreshToken } = await authService.refreshSession(decoded.id, decoded.tokenVersion, request.server);

    // OPTIMIZATION: Perform explicit Refresh Token Rotation mapping to the cookie
    if (refreshToken) {
        reply.setCookie('refreshToken', refreshToken, {
            path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 
        });
    }

    return { success: true, token: token, data: user };
}, 'Auth Refresh');

exports.logout = catchAsync(async (request, reply) => {
    await authService.revokeSession(request.user.id, request.server);

    reply.clearCookie('refreshToken', { path: '/' });
    return { success: true, message: 'Logged out successfully globally.' };
}, 'Auth Logout');

exports.verify = catchAsync(async (request, reply) => {
    const user = await authService.getUserById(request.query.id);
    if (!user) return reply.status(401).send({ success: false, message: 'Invalid or inactive session.' });
    
    return { success: true, message: 'Session verified', data: user };
}, 'Auth Verification');
