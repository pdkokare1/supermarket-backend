/* routes/authRoutes.js */

const authController = require('../controllers/authController');
const schemas = require('../schemas/authSchemas');

async function authRoutes(fastify, options) {
    fastify.get('/api/auth/setup', schemas.setupRateLimit, authController.setupAdmin);
    fastify.post('/api/auth/login', schemas.loginSchema, authController.login);
    fastify.post('/api/auth/refresh', authController.refresh);
    fastify.post('/api/auth/logout', { preHandler: [fastify.authenticate] }, authController.logout);
    fastify.get('/api/auth/verify', { schema: schemas.verifySchema.schema, preHandler: [fastify.authenticate] }, authController.verify);
}

module.exports = authRoutes;
