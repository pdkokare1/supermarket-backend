/* routes/settingsRoutes.js */

const Settings = require('../models/Settings');

async function settingsRoutes(fastify, options) {
    // Fetch global settings
    fastify.get('/api/settings', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            let settings = await Settings.findOne();
            if (!settings) {
                settings = await Settings.create({});
            }
            return { success: true, data: settings };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching settings' });
        }
    });

    // Update global settings (Admin Only)
    fastify.put('/api/settings', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            let settings = await Settings.findOne();
            if (!settings) {
                settings = new Settings();
            }
            
            const updates = request.body;
            Object.keys(updates).forEach(key => {
                settings[key] = updates[key];
            });
            
            await settings.save();
            return { success: true, message: 'Settings updated globally.', data: settings };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error updating settings' });
        }
    });
}

module.exports = settingsRoutes;
