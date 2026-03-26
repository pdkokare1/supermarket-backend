const mongoose = require('mongoose');

const registerSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true 
    }, // e.g., "Counter 1"
    storeId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Store', 
        required: true 
    },
    isActive: { 
        type: Boolean, 
        default: true 
    }
}, { timestamps: true });

// Optimize lookups for fetching registers belonging to a specific store
registerSchema.index({ storeId: 1, isActive: 1 });

module.exports = mongoose.model('Register', registerSchema);
