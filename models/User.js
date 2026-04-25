/* models/User.js */
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    pin: { type: String, required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null },
    defaultRegisterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Register' },
    role: { 
        type: String, 
        enum: ['SuperAdmin', 'StoreAdmin', 'Cashier', 'Distributor', 'Delivery_Agent'], 
        default: 'Cashier' 
    },
    
    // --- NEW: FLEET GEOSPATIAL TRACKING ---
    liveLocation: {
        lat: { type: Number, default: null },
        lng: { type: Number, default: null },
        lastPingedAt: { type: Date, default: null }
    },

    isActive: { type: Boolean, default: true },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date },
    tokenVersion: { type: Number, default: 0 }
}, { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

userSchema.virtual('isLocked').get(function() {
    return !!(this.lockUntil && this.lockUntil > Date.now());
});

// Cache Clearing Hooks
userSchema.post('save', function(doc) {
    if (!doc) return;
    setImmediate(async () => {
        try {
            const cacheUtils = require('../utils/cacheUtils');
            const redis = cacheUtils.getClient();
            if (redis) await redis.del(`cache:user:${doc._id.toString()}`);
        } catch (e) { console.warn('[CACHE] Failed to clear user cache', e.message); }
    });
});

userSchema.post('findOneAndUpdate', function(doc) {
    if(!doc) return;
    setImmediate(async () => {
        try {
            const cacheUtils = require('../utils/cacheUtils');
            const redis = cacheUtils.getClient();
            if (redis) await redis.del(`cache:user:${doc._id.toString()}`);
        } catch (e) { console.warn('[CACHE] Failed to clear user cache', e.message); }
    });
});

// Geospatial index for hyper-fast Rider assignment
userSchema.index({ "liveLocation.lat": 1, "liveLocation.lng": 1 });

module.exports = mongoose.model('User', userSchema);
