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
    splitDetails: {
        cash: { type: Number, default: 0 },
        upi: { type: Number, default: 0 }
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

// --- NEW OPTIMIZED LOGIC: Database Indexing for High-Speed Queries ---
// These indexes tell MongoDB to pre-sort data exactly how your app requests it.
orderSchema.index({ status: 1, createdAt: -1 }); // Speeds up the main Admin Dashboard
orderSchema.index({ deliveryType: 1, status: 1 }); // Speeds up the 6:00 AM Cron Job
orderSchema.index({ customerPhone: 1 }); // Speeds up POS Loyalty & Customer Deep-Dive lookups

module.exports = mongoose.model('Order', orderSchema);
