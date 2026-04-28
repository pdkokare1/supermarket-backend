/* models/User.js */
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    // --- EDITED FOR PHASE 4: Dual Auth System ---
    // StoreManagers use a complex password, Cashiers use a fast 4-digit PIN
    pin: { type: String, required: true }, 
    
    // --- NEW: TENANT ISOLATION ---
    // Links this user to a specific Enterprise Store (e.g., Reliance Smart - Pune)
    // If null, they are an HQ SuperAdmin
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null },
    defaultRegisterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Register' },
    
    // --- EDITED: STRICT RBAC HIERARCHY ---
    role: { 
        type: String, 
        enum: ['SuperAdmin', 'StoreManager', 'StoreAdmin', 'Cashier', 'Distributor', 'Delivery_Agent', 'Enterprise', 'Brand'], 
        default: 'Cashier' 
    },
    
    // --- EXISTING: FLEET GEOSPATIAL TRACKING ---
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

module.exports = mongoose.model('User', userSchema);
