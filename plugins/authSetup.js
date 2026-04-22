/* plugins/authSetup.js */

const User = require('../models/User');

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
            if (authHeader && authHeader.startsWith('Bearer ') && fastify.redis) {
                const token = authHeader.split(' ')[1];
                const isBlacklisted = await fastify.redis.get(`bl_${token}`);
                if (isBlacklisted) {
                    throw new Error('Token explicitly revoked via logout.');
                }
            }

            const decoded = await request.jwtVerify();
            let user;
            
            if (fastify.redis) {
                const cacheKey = `cache:user:${decoded.id}`;
                const cachedSession = await fastify.redis.get(cacheKey);
                
                if (cachedSession) {
                    user = JSON.parse(cachedSession);
                } else {
                    user = await User.findById(decoded.id).select('tokenVersion isActive role').lean();
                    if (user) {
                        // OPTIMIZATION: Dynamic Memory Management. Calculates exact seconds remaining on the JWT.
                        const currentTs = Math.floor(Date.now() / 1000);
                        const remainingTTL = Math.max(1, decoded.exp - currentTs);
                        
                        await fastify.redis.set(cacheKey, JSON.stringify(user), 'EX', remainingTTL); 
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
        if (!apiKey || apiKey !== process.env.EXTERNAL_API_KEY) {
            reply.status(401).send({ success: false, message: 'Unauthorized webhook access.' });
            return;
        }
    });
};
