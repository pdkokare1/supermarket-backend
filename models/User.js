/* models/User.js */

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true 
    },
    username: { 
        type: String, 
        required: true, 
        unique: true 
    },
    pin: { 
        type: String, 
        required: true 
    },
    assignedStores: [{ 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Store' 
    }],
    defaultRegisterId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Register' 
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
    failedLoginAttempts: { 
        type: Number, 
        default: 0 
    },
    lockUntil: { 
        type: Date 
    },
    tokenVersion: { 
        type: Number, 
        default: 0 
    }
}, { 
    timestamps: true,
    // ENTERPRISE FIX: Ensure virtual fields are included when document is serialized to the frontend or Redis
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// ENTERPRISE SECURITY FIX: Dynamic lock state calculation.
// Without this, the `if (user.isLocked)` check in authService.js will always fail, rendering brute-force protection useless.
userSchema.virtual('isLocked').get(function() {
    return !!(this.lockUntil && this.lockUntil > Date.now());
});

userSchema.post('save', function(doc) {
    if (!doc) return;
    setImmediate(async () => {
        try {
            const cacheUtils = require('../utils/cacheUtils');
            const redis = cacheUtils.getClient();
            if (redis) {
                await redis.del(`cache:user:${doc._id.toString()}`);
            }
        } catch (e) { console.warn('[CACHE] Failed to clear user session cache', e.message); }
    });
});

userSchema.post('findOneAndUpdate', function(doc) {
    if(!doc) return;
    setImmediate(async () => {
        try {
            const cacheUtils = require('../utils/cacheUtils');
            const redis = cacheUtils.getClient();
            if (redis) {
                await redis.del(`cache:user:${doc._id.toString()}`);
            }
        } catch (e) { console.warn('[CACHE] Failed to clear user session cache', e.message); }
    });
});

module.exports = mongoose.model('User', userSchema);
