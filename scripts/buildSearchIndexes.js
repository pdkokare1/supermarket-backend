/* scripts/buildSearchIndexes.js */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const MasterProduct = require('../models/MasterProduct');
const StoreInventory = require('../models/StoreInventory');
const Store = require('../models/Store');
const Order = require('../models/Order');

async function buildIndexes() {
    try {
        console.log('🔗 Connecting to Production Database...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected successfully.\n');

        console.log('⏳ Building Text Indexes for AI Catalog...');
        // Allows for ultra-fast full-text search on the Master Catalog
        await MasterProduct.collection.createIndex(
            { name: "text", brand: "text", searchTags: "text", category: "text" },
            { name: "Global_Catalog_Text_Index", background: true }
        );
        console.log('✅ Master Catalog text indexes applied.');

        console.log('⏳ Building Geospatial Indexes for B2C Location...');
        // Allows the B2C App to find nearby stores using lat/lng coordinates
        await Store.collection.createIndex(
            { location: "2dsphere" },
            { name: "Store_Location_2dsphere", background: true }
        );
        console.log('✅ Store Geospatial indexes applied.');

        console.log('⏳ Building Compound Indexes for Omni-Cart Engine...');
        // Crucial for performance: Allows the backend to instantly verify stock across multiple stores
        await StoreInventory.collection.createIndex(
            { storeId: 1, masterProductId: 1, variantId: 1 },
            { unique: true, name: "OmniCart_Fast_Lookup", background: true }
        );
        await StoreInventory.collection.createIndex(
            { storeId: 1, stock: 1 },
            { name: "Low_Stock_Scanner", background: true }
        );
        console.log('✅ Omni-Cart Compound indexes applied.');

        console.log('⏳ Building Ledger & Order Indexes...');
        // Speeds up the HQ financial dashboard when querying large order volumes
        await Order.collection.createIndex(
            { storeId: 1, status: 1, createdAt: -1 },
            { name: "HQ_Ledger_Sort", background: true }
        );
        await Order.collection.createIndex(
            { splitShipmentGroupId: 1 },
            { name: "Omni_Group_Tracker", background: true, sparse: true }
        );
        console.log('✅ Ledger indexes applied.\n');

        console.log('🚀 ALL PRODUCTION INDEXES BUILT SUCCESSFULLY.');
        process.exit(0);
    } catch (error) {
        console.error('❌ FATAL ERROR building indexes:', error);
        process.exit(1);
    }
}

buildIndexes();
