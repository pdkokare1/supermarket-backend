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
        enum: ['Open', 'Closed'], 
        default: 'Open' 
    }
}, { timestamps: true });

module.exports = mongoose.model('Shift', shiftSchema);
