/* routes/staffRoutes.js */

const staffController = require('../controllers/staffController');

async function staffRoutes(fastify, options) {
    fastify.post('/api/auth/register', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, staffController.createStaff);
    fastify.get('/api/users/staff', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, staffController.getStaff);
}

module.exports = staffRoutes;
