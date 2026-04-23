/* models/Order.js */

const mongoose = require('mongoose');

// --- NEW: Atomic Counter for Sequential Order Numbers (Phase 2) ---
const orderCounterSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    seq: { type: Number, default: 1000 }
});
// Attach to mongoose models cleanly so hot-reloads don't crash
const OrderCounter = mongoose.models.OrderCounter || mongoose.model('OrderCounter', orderCounterSchema);

// OPTIMIZATION: Schema wrapper to strip auto-generated _ids from cart items, saving Atlas storage size.
// strict: false ensures no frontend payload data is ever lost or rejected.
const orderItemSchema = new mongoose.Schema({}, { strict: false, _id: false });

const orderSchema = new mongoose.Schema({
    // --- NEW: Human Readable Order Identifier ---
    orderNumber: { 
        type: String, 
        unique: true,
        sparse: true // Allows backward compatibility for older documents
    },
    // --- NEW: Multi-Store Integration ---
    storeId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Store', 
        sparse: true // Allows legacy single-store orders to remain untouched
    },
    registerId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Register', 
        sparse: true 
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
        type: [orderItemSchema], 
        required: true 
    },
    // ENTERPRISE FIX: Native currency alignment for financial calculations
    currency: {
        type: String,
        default: 'Rs'
    },
    totalAmount: { 
        type: Number, 
        required: true,
        min: 0 // Deep Hardening
    },
    status: { 
        type: String, 
        default: 'Order Placed',
        // SECURITY FIX: Prevent payload injection by locking states
        enum: ['Order Placed', 'Packing', 'Dispatched', 'Delivered', 'Cancelled', 'Returned'] 
    },
    paymentMethod: { 
        type: String, 
        default: 'Cash on Delivery',
        // SECURITY FIX: Strict financial state boundaries
        enum: ['Cash on Delivery', 'UPI', 'Card', 'Pay Later', 'Mixed']
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

// --- OPTIMIZED INDEXES FOR HIGH-SPEED QUERIES ---
orderSchema.index({ status: 1, createdAt: -1 }); 
orderSchema.index({ deliveryType: 1, status: 1 }); 

// OPTIMIZATION: Covered index specifically for the getOrdersList aggregation
orderSchema.index({ deliveryType: 1, status: 1, createdAt: -1 }); 

orderSchema.index({ storeId: 1, createdAt: -1 });
orderSchema.index({ registerId: 1, createdAt: -1 });

// NEW: Compound index for CRM/Customer lookup speed
orderSchema.index({ customerPhone: 1, status: 1, createdAt: -1 }); 

// NEW: Compound index for Financial EOD aggregations
orderSchema.index({ paymentMethod: 1, createdAt: -1 });

// ENTERPRISE OPTIMIZATION: Deep Compound Index for Materialized View Rollups
orderSchema.index({ storeId: 1, status: 1, createdAt: -1 });

// ENTERPRISE OPTIMIZATION: Text Index for instant Admin search without regex COLLSCANs
orderSchema.index({ orderNumber: 'text', customerPhone: 'text', customerName: 'text' });

module.exports = mongoose.model('Order', orderSchema);
