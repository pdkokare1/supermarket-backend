/* models/Order.js */

const mongoose = require('mongoose');

// --- NEW: Atomic Counter for Sequential Order Numbers (Phase 2) ---
const orderCounterSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    seq: { type: Number, default: 1000 }
// ENTERPRISE OPTIMIZATION: Enforce Version Vector locking on counters
}, { optimisticConcurrency: true });
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
        sparse: true,
        trim: true
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
    // ENTERPRISE HARDENING: String sanitation
    customerName: { 
        type: String, 
        required: [true, 'Customer name is required'],
        trim: true,
        minlength: [2, 'Customer name must be at least 2 characters']
    },
    customerPhone: { 
        type: String, 
        required: [true, 'Customer phone is required'],
        trim: true
    },
    deliveryAddress: { 
        type: String, 
        required: [true, 'Delivery address is required'],
        trim: true
    },
    
    // --- NEW: AGGREGATOR FULFILLMENT ROUTING ---
    fulfillmentType: {
        type: String,
        enum: {
            values: ['PLATFORM_DELIVERY', 'STORE_DELIVERY', 'PICKUP'],
            message: '{VALUE} is not a valid fulfillment type'
        },
        default: 'PICKUP'
    },
    fulfillmentStatus: {
        type: String,
        enum: ['Pending', 'Dispatched', 'Arrived', 'Delivered', 'Failed'],
        default: 'Pending'
    },
    splitShipmentGroupId: {
        type: String,
        default: null, // Links multiple backend orders into one frontend B2C Cart
        trim: true
    },
    // --- NEW: PHASE 3 OMNI-CART TOTAL ---
    masterCartTotalRs: {
        type: Number,
        default: null, // Tracks the total Rs value of the entire combined multi-store cart
        min: [0, 'Cart total cannot be negative']
    },
    partnerTrackingId: {
        type: String,
        default: null, // For Croma / Reliance API integrations
        trim: true
    },

    // --- LEGACY: Delivery Instructions & Assignment ---
    notes: {
        type: String,
        default: '',
        trim: true
    },
    deliveryDriverName: {
        type: String,
        default: 'Unassigned',
        trim: true
    },
    driverPhone: {
        type: String,
        default: '',
        trim: true
    },
    items: { 
        type: [orderItemSchema], 
        required: true,
        // ENTERPRISE HARDENING: Reject empty orders at the DB level
        validate: {
            validator: function(v) { return v && v.length > 0; },
            message: 'An order must contain at least one item.'
        }
    },
    // ENTERPRISE FIX: Native currency alignment for financial calculations
    currency: {
        type: String,
        default: 'Rs',
        trim: true
    },
    totalAmount: { 
        type: Number, 
        required: [true, 'Total amount is required'],
        min: [0, 'Total amount cannot be negative'] // Deep Hardening
    },
    status: { 
        type: String, 
        default: 'Order Placed',
        // SECURITY FIX: Prevent payload injection by locking states
        enum: ['Order Placed', 'Packing', 'Dispatched', 'Delivered', 'Cancelled', 'Returned', 'Partially Refunded', 'Disputed'] 
    },
    paymentMethod: { 
        type: String, 
        default: 'Cash on Delivery',
        // SECURITY FIX: Strict financial state boundaries
        enum: ['Cash on Delivery', 'UPI', 'Card', 'Pay Later', 'Mixed', 'Online']
    },
    splitDetails: {
        cash: { type: Number, default: 0, min: [0, 'Cash split cannot be negative'] },
        upi: { type: Number, default: 0, min: [0, 'UPI split cannot be negative'] }
    },
    deliveryType: { 
        type: String, 
        default: 'Instant',
        trim: true
    },
    scheduleTime: { 
        type: String, 
        default: 'ASAP',
        trim: true 
    },
    // --- OPTIMIZATION: String-based date for instant analytics grouping ---
    dateString: {
        type: String,
        index: true,
        trim: true
    },
    
    // --- NEW: PHASE 10 B2B LOGISTICS & ERP TRACKING ---
    b2bLogistics: {
        erpSyncStatus: { type: String, enum: ['PENDING', 'SYNCED', 'FAILED', 'NOT_REQUIRED'], default: 'NOT_REQUIRED' },
        externalCourierId: { type: String, default: null, trim: true } // e.g., Croma's internal delivery van ID
    },

    // ============================================================================
    // --- NEW: PHASE 28 SECURE IN-APP CHAT (CUSTOMER <-> RIDER) ---
    // ============================================================================
    chatHistory: [{
        sender: { type: String, enum: ['Customer', 'Rider', 'System'] },
        message: { type: String, trim: true },
        timestamp: { type: Date, default: Date.now }
    }]
// ENTERPRISE OPTIMIZATION: optimisticConcurrency enforces Version Vector locking to prevent double-writes
}, { timestamps: true, optimisticConcurrency: true });

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

// ============================================================================
// --- NEW: PHASE 8 GEOSPATIAL FLEET ROUTING & COMPOUND INDEXING ---
// ============================================================================
orderSchema.add({
    location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], default: [73.7997, 18.6298] } // [lng, lat]
    }
});

// Geospatial index for the Rider Routing Manhattan Distance optimization
orderSchema.index({ location: '2dsphere', status: 1 });

// High-performance Compound Index to prevent full collection scans when HQ Heatmap loads
orderSchema.index({ fulfillmentType: 1, status: 1, createdAt: -1 });

// ============================================================================
// --- NEW: PHASE 9 PROOF OF DELIVERY (SECURE OTP) ---
// ============================================================================
orderSchema.add({
    deliveryOtp: { type: String, default: null, trim: true }
});

module.exports = mongoose.model('Order', orderSchema);
