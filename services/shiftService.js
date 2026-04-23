/* services/shiftService.js */

const Shift = require('../models/Shift');
const Order = require('../models/Order');
const AppError = require('../utils/AppError');
const auditService = require('./auditService'); 
const appEvents = require('../utils/eventEmitter'); 
const cacheUtils = require('../utils/cacheUtils'); 

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
    
    try {
        await newShift.save();
    } catch (error) {
        // ENTERPRISE FIX: Catch the specific unique index violation (E11000) triggered if 
        // two cashiers hit 'Open Shift' in the exact same millisecond.
        if (error.code === 11000) {
            throw new AppError('A shift was just opened by another register. Close it first.', 400);
        }
        throw error;
    }

    await auditService.logEvent({
        action: 'SHIFT_OPENED',
        targetType: 'Shift',
        targetId: newShift._id.toString(),
        userId: user ? user.id : null,
        username: user ? user.username : userName || 'System',
        details: { startingFloat: newShift.startingFloat },
        logError
    });

    await cacheUtils.deleteKey('shift:current');
    appEvents.emit('SHIFT_OPENED', { shiftId: newShift._id });

    return newShift;
};

exports.getCurrentShift = async () => {
    const CACHE_KEY = 'shift:current';
    let shift = await cacheUtils.getCachedData(CACHE_KEY);
    
    if (!shift) {
        shift = await Shift.findOne({ status: 'Open' }).lean();
        if (shift) await cacheUtils.setCachedData(CACHE_KEY, shift, 3600); 
    }
    
    return shift;
};

exports.closeShift = async (payload, user, logError) => {
    const { shiftId, actualCash } = payload;
    const shift = await Shift.findById(shiftId);
    
    if (!shift || shift.status === 'Closed') {
        throw new AppError('Shift not found or already closed.', 400);
    }

    const endTime = new Date();
    
    const orderStats = await Order.aggregate([
        { $match: { createdAt: { $gte: shift.startTime, $lte: endTime }, status: { $ne: 'Cancelled' } } },
        { $group: {
            _id: null,
            cashSales: { 
                $sum: { 
                    $cond: [
                        { $eq: ["$paymentMethod", "Cash"] }, "$totalAmount", 
                        { $cond: [{ $eq: ["$paymentMethod", "Split"] }, { $ifNull: ["$splitDetails.cash", 0] }, 0] }
                    ] 
                } 
            }
        }}
    ]);

    const cashSales = orderStats[0] ? orderStats[0].cashSales : 0;
    const expectedCash = shift.startingFloat + cashSales;

    shift.endTime = endTime;
    shift.expectedCash = expectedCash;
    shift.actualCash = Number(actualCash);
    shift.status = 'Closed';

    await shift.save();

    const discrepancy = shift.actualCash - shift.expectedCash;

    await auditService.logEvent({
        action: 'SHIFT_CLOSED',
        targetType: 'Shift',
        targetId: shift._id.toString(),
        userId: user ? user.id : null,
        username: user ? user.username : 'System',
        details: { expectedCash, actualCash: shift.actualCash, discrepancy },
        logError
    });

    await cacheUtils.deleteKey('shift:current');
    appEvents.emit('SHIFT_CLOSED', { shiftId: shift._id });

    return { shift, discrepancy };
};
