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

module.exports = mongoose.model('User', userSchema);
