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
                    user = {
                        _id: cachedSession._id,
                        role: cachedSession.role,
                        storeId: cachedSession.storeId || null,
                        tokenVersion: parseInt(cachedSession.tokenVersion, 10)
                    };
                }
            }

            if (!user) {
                user = await User.findById(decoded.id).lean();
                if (!user) throw new Error('User not found.');
                
                if (fastify.redis) {
                    await fastify.redis.hset(`cache:user:${user._id}`, {
                        _id: user._id.toString(),
                        role: user.role,
                        storeId: user.storeId ? user.storeId.toString() : '',
                        tokenVersion: user.tokenVersion || 0
                    });
                    await fastify.redis.expire(`cache:user:${user._id}`, 3600); 
                }
            }

            if (user.tokenVersion !== decoded.version) {
                throw new Error('Token version invalid. Password was likely changed.');
            }

            request.user = user; 
        } catch (err) {
            reply.code(401).send({ success: false, message: 'Unauthorized. Please log in again.' });
        }
    });

    // --- EXISTING DECORATORS ---
    fastify.decorate("verifyAdmin", async function (request, reply) {
        if (!request.user || !['SuperAdmin', 'StoreAdmin', 'StoreManager'].includes(request.user.role)) {
            reply.code(403).send({ success: false, message: 'Admin privileges required.' });
        }
    });

    fastify.decorate("verifyApiKey", async function (request, reply) {
        const apiKey = request.headers['x-api-key'];
        if (!apiKey || apiKey !== process.env.SYSTEM_API_KEY) {
            reply.code(403).send({ success: false, message: 'Invalid API Key' });
        }
    });

    // --- NEW: PHASE 4 RBAC DECORATORS ---
    fastify.decorate("verifySuperAdmin", async function (request, reply) {
        // Strict HQ God-Mode Check
        if (!request.user || request.user.role !== 'SuperAdmin') {
            reply.code(403).send({ success: false, message: 'HQ SuperAdmin privileges required.' });
        }
    });

    fastify.decorate("verifyStoreManager", async function (request, reply) {
        // Ensures the user can only act on their specific isolated store
        if (!request.user || !['StoreManager', 'SuperAdmin'].includes(request.user.role)) {
            reply.code(403).send({ success: false, message: 'Store Manager privileges required.' });
        }
    });
};
