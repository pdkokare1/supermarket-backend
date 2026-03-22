const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
    phone: { 
        type: String, 
        required: true,
        unique: true
    },
    name: { 
        type: String, 
        required: true 
    },
    isCreditEnabled: { 
        type: Boolean, 
        default: false 
    },
    creditLimit: { 
        type: Number, 
        default: 0 
    },
    creditUsed: { 
        type: Number, 
        default: 0 
    },
    loyaltyPoints: { 
        type: Number, 
        default: 0 
    }
}, { timestamps: true });

module.exports = mongoose.model('Customer', customerSchema);
