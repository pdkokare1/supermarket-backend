/* controllers/staffController.js */

const staffService = require('../services/staffService');
const catchAsync = require('../utils/catchAsync');

exports.createStaff = catchAsync(async (request, reply) => {
    const staffData = await staffService.createStaff(request.body);
    
    // REMOVED: request.server.broadcastToPOS (Now handled by Service events)

    return { success: true, message: 'User created successfully.', data: staffData };
}, 'during user creation');

exports.getStaff = catchAsync(async (request, reply) => {
    const staff = await staffService.getAllStaff();
    return { success: true, data: staff };
}, 'fetching staff');
