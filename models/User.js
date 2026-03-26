const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true 
    },
    username: { 
        type: String, 
        unique: true,
        sparse: true // Allows existing users without a username to coexist safely
    },
    pin: { 
        type: String, 
        required: true
        // MODIFIED: Removed unique: true to prevent duplicate key errors on default PINs
    },
    role: { 
        type: String, 
        enum: ['Admin', 'Cashier'], 
        default: 'Cashier' 
    },
    isActive: {
        type: Boolean,
        default: true
    },
    // --- SECURITY HARDENING: Token Versioning ---
    tokenVersion: { 
        type: Number, 
        default: 0 
    },
    // --- NEW: Brute-Force Protection ---
    failedLoginAttempts: {
        type: Number,
        default: 0
    },
    lockUntil: {
        type: Date
    }
}, { timestamps: true });

// --- NEW: Virtual field to check if the account is currently locked ---
userSchema.virtual('isLocked').get(function() {
    return !!(this.lockUntil && this.lockUntil > Date.now());
});

module.exports = mongoose.model('User', userSchema);
