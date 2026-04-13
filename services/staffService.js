/* services/staffService.js */

const User = require('../models/User');
const securityService = require('./securityService'); // Reusing Phase 2 module
const AppError = require('../utils/AppError');
const appEvents = require('../utils/eventEmitter'); // Added for event-driven updates
const cacheUtils = require('../utils/cacheUtils'); // OPTIMIZATION: Added for caching

exports.createStaff = async (payload) => {
    const { name, username, pin, role } = payload;
    
    if (!name || !username || !pin) {
        throw new AppError('Missing required fields.', 400);
    }

    const existingUser = await User.findOne({ username: username.trim() });
    if (existingUser) {
        throw new AppError('Username already exists.', 400);
    }

    const hashedPin = await securityService.hashPassword(pin.toString());
    
    const newUser = new User({
        name: name.trim(),
        username: username.trim(),
        pin: hashedPin,
        role: role || 'Cashier',
        isActive: true
    });

    await newUser.save();

    // OPTIMIZATION: Invalidate staff cache
    await cacheUtils.deleteKey('staff:all');

    // EVENT: Notify system of new staff creation
    appEvents.emit('STAFF_CREATED', { username: newUser.username });

    return { name: newUser.name, username: newUser.username, role: newUser.role };
};

exports.getAllStaff = async () => {
    // OPTIMIZATION: Cache staff list to speed up POS/Admin initialization
    const CACHE_KEY = 'staff:all';
    let staffList = await cacheUtils.getCachedData(CACHE_KEY);
    
    if (!staffList) {
        staffList = await User.find({ isActive: true })
            .select('-pin -tokenVersion -lockUntil -failedLoginAttempts')
            .lean();
        await cacheUtils.setCachedData(CACHE_KEY, staffList, 86400); // Cache for 24 hours (rarely changes)
    }
    
    return staffList;
};
