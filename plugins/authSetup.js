/* plugins/authSetup.js */
'use strict';

const User = require('../models/User');
const crypto = require('crypto');

module.exports = function (fastify) {
    if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
        fastify.log.error("CRITICAL: JWT_PRIVATE_KEY or JWT_PUBLIC_KEY is missing. Server shutting down.");
        process.exit(1);
    }

    fastify.register(require('@fastify/jwt'), {
        secret: {
            private: process.env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'),
            public: process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n')
        },
        sign: { 
            algorithm: 'RS256',
            expiresIn: '7d' 
        }
    });

    fastify.decorate("authenticate", async function (request, reply) {
        try {
            const authHeader = request.headers.authorization;
            
            // ENTERPRISE FIX: Strict format validation prevents unnecessary Redis hits for malformed tokens
            if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ').length !== 2) {
                throw new Error('Missing or malformed token format.');
            }

            const token = authHeader.split(' ')[1];
            
            if (fastify.redis) {
                const isBlacklisted = await fastify.redis.get(`bl_${token}`);
                if (isBlacklisted) throw new Error('Token explicitly revoked via logout.');
            }

            const decoded = await request.jwtVerify();
            let user;
            
            if (fastify.redis) {
                const cacheKey = `cache:user:${decoded.id}`;
                // OPTIMIZATION: Replaced slow JSON parse with native Redis Hashes to protect event loop
                const cachedSession = await fastify.redis.hgetall(cacheKey);
                
                if (cachedSession && Object.keys(cachedSession).length > 0) {
                    // Reconstruct the user object with native types
                    user = {
                        _id: decoded.id,
                        tokenVersion: parseInt(cachedSession.tokenVersion, 10),
                        isActive: cachedSession.isActive === 'true',
                        role: cachedSession.role
                    };
                } else {
                    user = await User.findById(decoded.id).select('tokenVersion isActive role').lean();
                    if (user) {
                        const currentTs = Math.floor(Date.now() / 1000);
                        const remainingTTL = Math.max(1, decoded.exp - currentTs);
                        
                        // OPTIMIZATION: Store natively as Hash
                        await fastify.redis.hset(cacheKey, {
                            tokenVersion: user.tokenVersion,
                            isActive: String(user.isActive),
                            role: user.role
                        });
                        await fastify.redis.expire(cacheKey, remainingTTL);
                    }
                }
            } else {
                user = await User.findById(decoded.id).select('tokenVersion isActive role').lean();
            }
            
            if (!user || !user.isActive || user.tokenVersion !== decoded.tokenVersion) {
                throw new Error('Token revoked or user inactive');
            }
            
            request.user = user;
            
        } catch (err) {
            reply.status(401).send({ success: false, message: 'Unauthorized: Invalid or missing token.' });
        }
    });

    fastify.decorate("verifyAdmin", async function (request, reply) {
        if (request.user && request.user.role !== 'Admin') {
            reply.status(403).send({ success: false, message: 'Forbidden: Admin access required.' });
            return; 
        }
    });

    fastify.decorate("verifyApiKey", async function (request, reply) {
        const apiKey = request.headers['x-api-key'];
        
        // ENTERPRISE FIX: Constant-time comparison to prevent timing side-channel attacks
        if (!apiKey) {
            reply.status(401).send({ success: false, message: 'Unauthorized webhook access.' });
            return;
        }

        const expectedKeyBuffer = Buffer.from(process.env.EXTERNAL_API_KEY || '');
        const providedKeyBuffer = Buffer.from(apiKey);

        if (expectedKeyBuffer.length !== providedKeyBuffer.length || !crypto.timingSafeEqual(expectedKeyBuffer, providedKeyBuffer)) {
            reply.status(401).send({ success: false, message: 'Unauthorized webhook access.' });
            return;
        }
    });
};
