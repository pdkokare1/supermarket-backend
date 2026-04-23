/* services/securityService.js */

const bcrypt = require('bcrypt');

exports.generateTokens = (server, user) => {
    const tokenVersion = user.tokenVersion || 0;
    
    // Refresh Token: Long-lived (7 Days). Used only to fetch new access tokens via HttpOnly cookies.
    const refreshToken = server.jwt.sign(
        { id: user._id, tokenVersion }, 
        { expiresIn: '7d' }
    );

    // ENTERPRISE SECURITY FIX: Access tokens MUST be short-lived. 
    // The frontend will automatically rotate this using the refresh token, keeping cashiers logged in seamlessly.
    const token = server.jwt.sign(
        { id: user._id, role: user.role, username: user.username, tokenVersion },
        { expiresIn: '1h' }
    );

    return { token, refreshToken };
};

exports.hashPassword = async (password) => {
    const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12;
    return await bcrypt.hash(password, saltRounds);
};

exports.comparePassword = async (password, hash) => {
    return await bcrypt.compare(password, hash);
};
