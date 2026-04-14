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
    // --- NEW: Multi-Store Employee Assignment ---
    assignedStores: [{ 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Store' 
    }],
    defaultRegisterId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Register' 
    },
    // --- ENHANCED: Strict Role-Based Access Control (RBAC) ---
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
}, { timestamps: true });

// OPTIMIZATION: Auto-invalidate Redis session cache immediately upon security/role updates
userSchema.post('save', async function(doc) {
    try {
        const cacheUtils = require('../utils/cacheUtils');
        const redis = cacheUtils.getClient();
        if (redis) {
            await redis.del(`auth:session:${doc._id.toString()}`);
        }
    } catch (e) { console.warn('[CACHE] Failed to clear user session cache', e.message); }
});

userSchema.post('findOneAndUpdate', async function(doc) {
    if(!doc) return;
    try {
        const cacheUtils = require('../utils/cacheUtils');
        const redis = cacheUtils.getClient();
        if (redis) {
            await redis.del(`auth:session:${doc._id.toString()}`);
        }
    } catch (e) { console.warn('[CACHE] Failed to clear user session cache', e.message); }
});

module.exports = mongoose.model('User', userSchema);
