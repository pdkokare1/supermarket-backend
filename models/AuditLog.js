/* models/AuditLog.js */

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
    userId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User',
        required: false // Optional in case of system-generated logs
    },
    username: {
        type: String,
        default: 'System'
    },
    action: { 
        type: String, 
        required: true 
    },
    targetType: { 
        type: String, 
        required: true // e.g., 'Order', 'Product', 'Customer'
    },
    targetId: { 
        type: String, 
        required: true 
    },
    details: { 
        type: Object, 
        default: {} 
    },
    // OPTIMIZATION: Immutable State Tracking for strict compliance ledgers
    previousState: {
        type: Object,
        default: null
    },
    newState: {
        type: Object,
        default: null
    }
}, { timestamps: true });

// Optimize for fetching recent logs quickly in the admin panel
auditLogSchema.index({ createdAt: -1 });

// NEW: Compound index. Drastically speeds up tracking the history of a specific item or order.
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
