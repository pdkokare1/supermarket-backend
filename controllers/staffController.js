/* controllers/staffController.js */

const staffService = require('../services/staffService');
const catchAsync = require('../utils/catchAsync');

exports.createStaff = catchAsync(async (request, reply) => {
    const staffData = await staffService.createStaff(request.body);
    
    // MODULARIZED: Alert real-time admin dashboards
    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'STAFF_CREATED', username: staffData.username });
    }

    return { success: true, message: 'User created successfully.', data: staffData };
}, 'during user creation');

exports.getStaff = catchAsync(async (request, reply) => {
    const staff = await staffService.getAllStaff();
    return { success: true, data: staff };
}, 'fetching staff');
