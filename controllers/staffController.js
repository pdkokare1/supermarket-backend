/* controllers/staffController.js */

const staffService = require('../services/staffService');

exports.createStaff = async (request, reply) => {
    const staffData = await staffService.createStaff(request.body);
    
    // REMOVED: request.server.broadcastToPOS (Now handled by Service events)

    return { success: true, message: 'User created successfully.', data: staffData };
};

exports.getStaff = async (request, reply) => {
    const staff = await staffService.getAllStaff();
    return { success: true, data: staff };
};
