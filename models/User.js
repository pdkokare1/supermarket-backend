const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true 
    },
    username: { 
        type: String, 
        unique: true,
        sparse: true // Allows existing users without a username to coexist safely
    },
    pin: { 
        type: String, 
        required: true,
        unique: true
    },
    role: { 
        type: String, 
        enum: ['Admin', 'Cashier'], 
        default: 'Cashier' 
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
