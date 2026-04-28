/* scripts/buildSearchIndexes.js */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

// MODIFIED: Pointing to the new B2B Omnichannel Master Catalog
const MasterProduct = require('../models/MasterProduct'); 
const StoreInventory = require('../models/StoreInventory'); // Added for Omni-Cart
const Store = require('../models/Store'); // Added for Geospatial
const Order = require('../models/Order'); // Added for HQ Ledger

async function buildIndexes() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB.');

        console.log('Building Text Indexes for The Gamut Master Catalog...');
        
        // This command forces MongoDB to build a text index on name, brand, and searchTags.
        // We assign weights so that a match in 'name' scores higher than a match in 'searchTags'.
        await MasterProduct.collection.createIndex(
            { 
                name: "text", 
                brand: "text", 
                searchTags: "text" 
            },
            { 
                weights: { name: 10, brand: 5, searchTags: 2 },
                name: "Master_Catalog_Search_Index"
            }
        );

        // --- NEW: APPENDED INDEXES FOR PRODUCTION LAUNCH ---

        console.log('Building Geospatial Indexes for B2C Location...');
        // Allows the B2C App to find nearby stores using lat/lng coordinates
        await Store.collection.createIndex(
            { location: "2dsphere" },
            { name: "Store_Location_2dsphere", background: true }
        );

        console.log('Building Compound Indexes for Omni-Cart Engine...');
        // Crucial for performance: Allows the backend to instantly verify stock across multiple stores
        await StoreInventory.collection.createIndex(
            { storeId: 1, masterProductId: 1, variantId: 1 },
            { unique: true, name: "OmniCart_Fast_Lookup", background: true }
        );
        await StoreInventory.collection.createIndex(
            { storeId: 1, stock: 1 },
            { name: "Low_Stock_Scanner", background: true }
        );

        console.log('Building Ledger & Order Indexes...');
        // Speeds up the HQ financial dashboard when querying large order volumes
        await Order.collection.createIndex(
            { storeId: 1, status: 1, createdAt: -1 },
            { name: "HQ_Ledger_Sort", background: true }
        );
        await Order.collection.createIndex(
            { splitShipmentGroupId: 1 },
            { name: "Omni_Group_Tracker", background: true, sparse: true }
        );

        console.log('Indexes built successfully! Global catalog search is now heavily optimized.');
        process.exit(0);
    } catch (error) {
        console.error('Error building indexes:', error);
        process.exit(1);
    }
}

buildIndexes();
