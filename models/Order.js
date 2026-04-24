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
const orderItemSchema = new mongoose.Schema({
    // Explicitly defining new multi-tenant pointers while keeping strict: false for legacy payloads
    masterProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'MasterProduct' },
    storeInventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreInventory' }
}, { strict: false, _id: false });

const orderSchema = new mongoose.Schema({
    // --- NEW: Human Readable Order Identifier ---
    orderNumber: { 
        type: String, 
        unique: true,
        sparse: true 
    },
    // --- NEW: Multi-Store Integration ---
    storeId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Store', 
        sparse: true 
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
    
    // --- NEW: AGGREGATOR FULFILLMENT ROUTING ---
    fulfillmentType: {
        type: String,
        enum: ['PLATFORM_DELIVERY', 'STORE_DELIVERY', 'PICKUP'],
        default: 'PICKUP'
    },
    fulfillmentStatus: {
        type: String,
        enum: ['Pending', 'Dispatched', 'Arrived', 'Delivered', 'Failed'],
        default: 'Pending'
    },
    splitShipmentGroupId: {
        type: String,
        default: null // Links multiple backend orders into one frontend B2C Cart
    },
    partnerTrackingId: {
        type: String,
        default: null // For Croma / Reliance API integrations
    },

    // --- LEGACY: Delivery Instructions & Assignment ---
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
orderSchema.index({ deliveryType: 1, status: 1, createdAt: -1 }); 
orderSchema.index({ storeId: 1, createdAt: -1 });
orderSchema.index({ registerId: 1, createdAt: -1 });
orderSchema.index({ customerPhone: 1, status: 1, createdAt: -1 }); 
orderSchema.index({ paymentMethod: 1, createdAt: -1 });
orderSchema.index({ storeId: 1, status: 1, createdAt: -1 });
orderSchema.index({ splitShipmentGroupId: 1 }); // Fast B2C Cart aggregation
orderSchema.index({ orderNumber: 'text', customerPhone: 'text', customerName: 'text' });

module.exports = mongoose.model('Order', orderSchema);
