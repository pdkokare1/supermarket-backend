/* services/securityService.js */

const bcrypt = require('bcrypt');

exports.generateTokens = (server, user) => {
    const tokenVersion = user.tokenVersion || 0;
    
    const refreshToken = server.jwt.sign(
        { id: user._id, tokenVersion }, 
        { expiresIn: '7d' }
    );

    const token = server.jwt.sign(
        { id: user._id, role: user.role, username: user.username, tokenVersion }, 
        { expiresIn: '7d' }
    );

    return { token, refreshToken };
};

exports.hashPassword = async (password) => {
    return await bcrypt.hash(password, 10);
};

exports.comparePassword = async (password, hash) => {
    return await bcrypt.compare(password, hash);
};
