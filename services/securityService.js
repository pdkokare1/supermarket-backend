/* services/securityService.js */

const bcrypt = require('bcrypt');

exports.generateTokens = (server, user) => {
    const tokenVersion = user.tokenVersion || 0;
    
    // Refresh Token: Long-lived (7 Days). Used only to fetch new access tokens.
    const refreshToken = server.jwt.sign(
        { id: user._id, tokenVersion }, 
        { expiresIn: '7d' }
    );

    // Access Token: Short-lived (15 Minutes). Inherits the '15m' strict config from authSetup.js.
    // OPTIMIZATION FIX: Removed manual 7d override to prevent XSS hijacking vulnerabilities.
    const token = server.jwt.sign(
        { id: user._id, role: user.role, username: user.username, tokenVersion }
    );

    return { token, refreshToken };
};

exports.hashPassword = async (password) => {
    return await bcrypt.hash(password, 10);
};

exports.comparePassword = async (password, hash) => {
    return await bcrypt.compare(password, hash);
};
