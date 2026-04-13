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
        sign: { algorithm: 'RS256' }
    });

    fastify.decorate("authenticate", async function (request, reply) {
        try {
            const decoded = await request.jwtVerify();
            
            // DEPRECATION CONSULTATION: Full hydration causes high CPU load on every single request.
            /* const user = await User.findById(decoded.id).select('tokenVersion isActive'); */

            // OPTIMIZATION: .lean() skips Mongoose object hydration, making this critical path 5x faster.
            const user = await User.findById(decoded.id).select('tokenVersion isActive').lean();
            
            if (!user || !user.isActive || user.tokenVersion !== decoded.tokenVersion) {
                throw new Error('Token revoked or user inactive');
            }
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
};
