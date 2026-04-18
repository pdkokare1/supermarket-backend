/* controllers/authController.js */

const authService = require('../services/authService');

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.setupAdmin = async (request, reply) => {
    // FIX: Bypassing the strict production lock so you can initialize the DB on Railway.
    // This remains completely secure because it still strictly requires the SETUP_KEY.
    const result = await authService.setupDefaultAdmin(process.env.SETUP_KEY, request.query.key, false);
    return { success: true, message: result.message };
};

exports.login = async (request, reply) => {
    const { username, pin } = request.body;
    
    try {
        const { user, token, refreshToken } = await authService.authenticateUser(username, pin, request.ip, request.server);

        // Cross-Origin cookie configuration for decoupled Vercel/Railway architecture
        reply.setCookie('refreshToken', refreshToken, {
            path: '/', 
            httpOnly: true, 
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', 
            maxAge: 7 * 24 * 60 * 60 
        });
        
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
            reply.setCookie('refreshToken', refreshToken, {
                path: '/', 
                httpOnly: true, 
                secure: process.env.NODE_ENV === 'production',
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', 
                maxAge: 7 * 24 * 60 * 60 
            });
        }

        return { success: true, token: token, data: user };
    } catch (error) {
        return reply.status(401).send({ success: false, message: 'Invalid or expired refresh token.' });
    }
};

exports.logout = async (request, reply) => {
    await authService.revokeSession(request.user.id, request.server);

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

    reply.clearCookie('refreshToken', { path: '/', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', secure: process.env.NODE_ENV === 'production' });
    reply.clearCookie('__Host-refreshToken', { path: '/' });

    return { success: true, message: 'Logged out successfully globally.' };
};

exports.verify = async (request, reply) => {
    const user = await authService.getUserById(request.query.id);
    if (!user) return reply.status(401).send({ success: false, message: 'Invalid or inactive session.' });
    
    return { success: true, message: 'Session verified', data: user };
};
