/* routes/shiftRoutes.js */

const shiftController = require('../controllers/shiftController');

const openShiftSchema = {
    schema: {
        body: { type: 'object', required: ['startingFloat'], properties: { userName: { type: 'string' }, startingFloat: { type: 'number', minimum: 0 } } }
    }
};

const closeShiftSchema = {
    schema: {
        body: { type: 'object', required: ['shiftId', 'actualCash'], properties: { shiftId: { type: 'string' }, actualCash: { type: 'number', minimum: 0 } } }
    }
};

async function shiftRoutes(fastify, options) {
    fastify.post('/api/shifts/open', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...openShiftSchema }, shiftController.openShift);
    fastify.get('/api/shifts/current', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, shiftController.getCurrentShift);
    fastify.put('/api/shifts/close', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...closeShiftSchema }, shiftController.closeShift);
}

module.exports = shiftRoutes;
