/* plugins/authSetup.js */

const User = require('../models/User');

module.exports = function (fastify) {
    if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
        fastify.log.error("CRITICAL: JWT_PRIVATE_KEY or JWT_PUBLIC_KEY is missing. Server shutting down.");
        process.exit(1);
    }

    // ENTERPRISE OPTIMIZATION: Enforcing short-lived TTL mapping directly onto the payload signing
    fastify.register(require('@fastify/jwt'), {
        secret: {
            private: process.env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'),
            public: process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n')
        },
        sign: { 
            algorithm: 'RS256',
            expiresIn: '7d' // FIX: Extended to 7 days for POS store efficiency
        }
    });

    fastify.decorate("authenticate", async function (request, reply) {
        try {
            // OPTIMIZATION: Explicit Blacklist check to instantly block tokens revoked via the /logout route
            const authHeader = request.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ') && fastify.redis) {
                const token = authHeader.split(' ')[1];
                const isBlacklisted = await fastify.redis.get(`bl_${token}`);
                if (isBlacklisted) {
                    throw new Error('Token explicitly revoked via logout.');
                }
            }

            const decoded = await request.jwtVerify();
            let user;
            
            // OPTIMIZATION: High-speed Redis caching for session verification
            if (fastify.redis) {
                // SECURITY FIX: Synchronized cache key with authService.js (cache:user) 
                // Prevents revoked tokens from surviving in mismatched cache silos.
                const cacheKey = `cache:user:${decoded.id}`;
                const cachedSession = await fastify.redis.get(cacheKey);
                
                if (cachedSession) {
                    user = JSON.parse(cachedSession);
                } else {
                    // Fallback to .lean() which skips Mongoose object hydration, making this critical path faster
                    user = await User.findById(decoded.id).select('tokenVersion isActive role').lean();
                    if (user) {
                        // FIX: Extended cache TTL to 7 days (604800 seconds) to match the new token expiry
                        await fastify.redis.set(cacheKey, JSON.stringify(user), 'EX', 604800); 
                    }
                }
            } else {
                user = await User.findById(decoded.id).select('tokenVersion isActive role').lean();
            }
            
            // The tokenVersion check is what guarantees that logging out (which increments the DB version) 
            // instantly invalidates all currently active short-lived access tokens.
            if (!user || !user.isActive || user.tokenVersion !== decoded.tokenVersion) {
                throw new Error('Token revoked or user inactive');
            }
            
            // Attach user to request for downstream RBAC checking
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

    // ENTERPRISE OPTIMIZATION: Extracted external API key validation into a reusable middleware decorator
    fastify.decorate("verifyApiKey", async function (request, reply) {
        const apiKey = request.headers['x-api-key'];
        if (!apiKey || apiKey !== process.env.EXTERNAL_API_KEY) {
            reply.status(401).send({ success: false, message: 'Unauthorized webhook access.' });
            return;
        }
    });
};
