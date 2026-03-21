const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    customerName: { 
        type: String, 
        required: true 
    },
    customerPhone: { 
        type: String, 
        required: true 
    },
    deliveryAddress: { 
        type: String, 
        required: true 
    },
    items: { 
        type: Array, 
        required: true 
    },
    totalAmount: { 
        type: Number, 
        required: true 
    },
    status: { 
        type: String, 
        default: 'Order Placed' 
    },
    paymentMethod: { 
        type: String, 
        default: 'Cash on Delivery' 
    },
    // NEW: Split Payment details
    splitDetails: {
        cash: { type: Number, default: 0 },
        upi: { type: Number, default: 0 }
    },
    // NEW: Routine & Scheduling features
    deliveryType: { 
        type: String, 
        default: 'Instant' // Can be 'Instant' or 'Routine'
    },
    scheduleTime: { 
        type: String, 
        default: 'ASAP' // Can be 'ASAP', 'Daily at 7 AM', 'Daily at 6 PM', etc.
    }
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
