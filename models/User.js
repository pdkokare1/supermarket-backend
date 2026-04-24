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
    // Multi-Tenancy Strict Boundary
    tenantId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Store',
        default: null // null indicates a Platform SuperAdmin
    },
    defaultRegisterId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Register' 
    },
    role: { 
        type: String, 
        enum: ['SuperAdmin', 'StoreAdmin', 'Cashier', 'Distributor', 'Delivery_Agent'], 
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
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

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
