/* routes/collectiveRoutes.js */
'use strict';

const collectiveController = require('../controllers/collectiveController');

module.exports = async function (fastify, opts) {
    // Allows users to start a new viral group buy for their apartment building
    fastify.post('/api/collectives/create', { preHandler: [fastify.authenticate] }, collectiveController.createCollective);
    
    // Allows neighbors to lock in their Rs payment and join the active countdown
    fastify.post('/api/collectives/:id/join', { preHandler: [fastify.authenticate] }, collectiveController.joinCollective);
};
