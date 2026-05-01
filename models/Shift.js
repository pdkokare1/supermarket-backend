/* models/Shift.js */
const mongoose = require('mongoose');

const shiftSchema = new mongoose.Schema({
    userName: { 
        type: String, 
        required: true 
    },
    startTime: { 
        type: Date, 
        default: Date.now 
    },
    endTime: { 
        type: Date, 
        default: null 
    },
    startingFloat: { 
        type: Number, 
        required: true,
        default: 0
    },
    expectedCash: { 
        type: Number, 
        default: 0 
    },
    actualCash: { 
        type: Number, 
        default: 0 
    },
    status: { 
        type: String, 
        enum: ['Open', 'Closed', 'Offline', 'ACTIVE'], // Modified for Phase 20/28 compatibility
        default: 'Open' 
    },
    role: {
        type: String,
        default: 'Cashier'
    },
    // ============================================================================
    // --- NEW: PHASE 28 SELF-HEALING LOGISTICS (WATCHDOG PING) ---
    // ============================================================================
    lastPingTime: { 
        type: Date, 
        default: Date.now 
    },
    spatialLocation: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], default: [0, 0] } 
    }
}, { timestamps: true });

// ENTERPRISE FIX: Database-level lock preventing multiple open shifts globally.
// This permanently eliminates cash-drawer concurrency race conditions.
shiftSchema.index({ status: 1 }, { unique: true, partialFilterExpression: { status: 'Open', role: 'Cashier' } });
shiftSchema.index({ spatialLocation: '2dsphere' });

module.exports = mongoose.model('Shift', shiftSchema);
