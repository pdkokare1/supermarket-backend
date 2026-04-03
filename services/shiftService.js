/* services/shiftService.js */

const Shift = require('../models/Shift');
const Order = require('../models/Order');
const AuditLog = require('../models/AuditLog');
const AppError = require('../utils/AppError');

exports.openShift = async (payload, user, logError) => {
    const { userName, startingFloat } = payload;
    
    const existingShift = await Shift.findOne({ status: 'Open' });
    if (existingShift) {
        throw new AppError('A shift is already open. Close it first.', 400);
    }

    const newShift = new Shift({
        userName: userName || 'Cashier',
        startingFloat: Number(startingFloat) || 0,
        status: 'Open'
    });
    
    await newShift.save();

    await AuditLog.create({
        userId: user ? user.id : null,
        username: user ? user.username : userName || 'System',
        action: 'SHIFT_OPENED',
        targetType: 'Shift',
        targetId: newShift._id.toString(),
        details: { startingFloat: newShift.startingFloat }
    }).catch(e => logError('AuditLog Error:', e));

    return newShift;
};

exports.getCurrentShift = async () => {
    return await Shift.findOne({ status: 'Open' }).lean();
};

exports.closeShift = async (payload, user, logError) => {
    const { shiftId, actualCash } = payload;
    const shift = await Shift.findById(shiftId);
    
    if (!shift || shift.status === 'Closed') {
        throw new AppError('Shift not found or already closed.', 400);
    }

    const endTime = new Date();
    
    const shiftOrders = await Order.find({
        createdAt: { $gte: shift.startTime, $lte: endTime },
        status: { $ne: 'Cancelled' }
    });

    let cashSales = 0;
    shiftOrders.forEach(o => {
        if (o.paymentMethod === 'Cash') {
            cashSales += o.totalAmount;
        } else if (o.paymentMethod === 'Split' && o.splitDetails) {
            cashSales += (o.splitDetails.cash || 0);
        }
    });

    const expectedCash = shift.startingFloat + cashSales;

    shift.endTime = endTime;
    shift.expectedCash = expectedCash;
    shift.actualCash = Number(actualCash);
    shift.status = 'Closed';

    await shift.save();

    const discrepancy = shift.actualCash - shift.expectedCash;

    await AuditLog.create({
        userId: user ? user.id : null,
        username: user ? user.username : 'System',
        action: 'SHIFT_CLOSED',
        targetType: 'Shift',
        targetId: shift._id.toString(),
        details: { expectedCash, actualCash: shift.actualCash, discrepancy }
    }).catch(e => logError('AuditLog Error:', e));

    return { shift, discrepancy };
};
