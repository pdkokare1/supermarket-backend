/* controllers/shiftController.js */

const shiftService = require('../services/shiftService');
const catchAsync = require('../utils/catchAsync');

exports.openShift = catchAsync(async (request, reply) => {
    const newShift = await shiftService.openShift(request.body, request.user, request.server.log.error.bind(request.server.log));

    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'SHIFT_OPENED', shiftId: newShift._id });
    }

    return { success: true, data: newShift, message: 'Register Opened Successfully!' };
}, 'opening shift');

exports.getCurrentShift = catchAsync(async (request, reply) => {
    const currentShift = await shiftService.getCurrentShift();
    return { success: true, data: currentShift || null };
}, 'fetching shift');

exports.closeShift = catchAsync(async (request, reply) => {
    const { shift, discrepancy } = await shiftService.closeShift(request.body, request.user, request.server.log.error.bind(request.server.log));

    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'SHIFT_CLOSED', shiftId: shift._id });
    }

    return { 
        success: true, 
        message: 'Register Closed Successfully', 
        data: shift,
        discrepancy: discrepancy 
    };
}, 'closing shift');
