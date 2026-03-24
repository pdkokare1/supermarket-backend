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
        required: true,
        min: 0 // Deep Hardening
    },
    status: { 
        type: String, 
        default: 'Order Placed' 
    },
    paymentMethod: { 
        type: String, 
        default: 'Cash on Delivery' 
    },
    splitDetails: {
        cash: { type: Number, default: 0, min: 0 },
        upi: { type: Number, default: 0, min: 0 }
    },
    deliveryType: { 
        type: String, 
        default: 'Instant' 
    },
    scheduleTime: { 
        type: String, 
        default: 'ASAP' 
    }
}, { timestamps: true });

orderSchema.index({ status: 1, createdAt: -1 }); 
orderSchema.index({ deliveryType: 1, status: 1 }); 
orderSchema.index({ customerPhone: 1 }); 

module.exports = mongoose.model('Order', orderSchema);
