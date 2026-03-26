const mongoose = require('mongoose');

// --- NEW: Atomic Counter for Sequential Order Numbers (Phase 2) ---
const orderCounterSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    seq: { type: Number, default: 1000 }
});
// Attach to mongoose models cleanly so hot-reloads don't crash
const OrderCounter = mongoose.models.OrderCounter || mongoose.model('OrderCounter', orderCounterSchema);

const orderSchema = new mongoose.Schema({
    // --- NEW: Human Readable Order Identifier ---
    orderNumber: { 
        type: String, 
        unique: true,
        sparse: true // Allows backward compatibility for older documents
    },
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
    // --- NEW FUNCTIONALITY: Delivery Instructions & Assignment ---
    notes: {
        type: String,
        default: ''
    },
    deliveryDriverName: {
        type: String,
        default: 'Unassigned'
    },
    driverPhone: {
        type: String,
        default: ''
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
    },
    // --- OPTIMIZATION: String-based date for instant analytics grouping ---
    dateString: {
        type: String,
        index: true
    }
}, { timestamps: true });

orderSchema.index({ status: 1, createdAt: -1 }); 
orderSchema.index({ deliveryType: 1, status: 1 }); 
orderSchema.index({ customerPhone: 1 }); 
orderSchema.index({ orderNumber: 1 }); // Index for fast lookup on the new field

module.exports = mongoose.model('Order', orderSchema);
