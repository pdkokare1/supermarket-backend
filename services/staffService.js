/* services/staffService.js */

const User = require('../models/User');
const securityService = require('./securityService'); // Reusing Phase 2 module
const AppError = require('../utils/AppError');
const appEvents = require('../utils/eventEmitter'); // Added for event-driven updates

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

    // EVENT: Notify system of new staff creation
    appEvents.emit('STAFF_CREATED', { username: newUser.username });

    return { name: newUser.name, username: newUser.username, role: newUser.role };
};

exports.getAllStaff = async () => {
    return await User.find({ isActive: true }).select('-pin -tokenVersion -lockUntil -failedLoginAttempts').lean();
};
