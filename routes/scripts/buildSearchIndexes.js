/* scripts/buildSearchIndexes.js */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/Product'); 

async function buildIndexes() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB.');

        console.log('Building Text Indexes for The Gamut Consumer Storefront...');
        
        // This command forces MongoDB to build a text index on name, brand, and searchTags.
        // We assign weights so that a match in 'name' scores higher than a match in 'searchTags'.
        await Product.collection.createIndex(
            { 
                name: "text", 
                brand: "text", 
                searchTags: "text" 
            },
            { 
                weights: { name: 10, brand: 5, searchTags: 2 },
                name: "Consumer_Storefront_Search_Index"
            }
        );

        console.log('Indexes built successfully! Consumer search is now heavily optimized.');
        process.exit(0);
    } catch (error) {
        console.error('Error building indexes:', error);
        process.exit(1);
    }
}

buildIndexes();
