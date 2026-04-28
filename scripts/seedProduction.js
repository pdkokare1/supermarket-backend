/* scripts/seedProduction.js */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const Store = require('../models/Store');
const Category = require('../models/Category');

async function runSeed() {
    try {
        console.log('🌱 Initiating Day-1 Database Seed...');
        await mongoose.connect(process.env.MONGODB_URI);

        // 1. Create the God-Mode SuperAdmin (HQ)
        const adminExists = await User.findOne({ username: 'hqadmin' });
        if (!adminExists) {
            const salt = await bcrypt.genSalt(10);
            const hashedPin = await bcrypt.hash('1234', salt); // Default PIN: 1234

            await User.create({
                name: 'DailyPick HQ',
                username: 'hqadmin',
                pin: hashedPin,
                role: 'SuperAdmin',
                isActive: true
            });
            console.log('✅ SuperAdmin Account Created (Username: hqadmin | PIN: 1234)');
        }

        // 2. Create the first test Enterprise Store
        const storeExists = await Store.findOne({ storeType: 'ENTERPRISE' });
        if (!storeExists) {
            await Store.create({
                name: 'Croma (Sandbox)',
                location: 'Downtown Mall',
                storeType: 'ENTERPRISE',
                fulfillmentOptions: ['STORE_DELIVERY', 'PICKUP'],
                commercialTerms: { commissionType: 'PERCENTAGE', commissionValue: 3.5 },
                apiIntegration: {
                    apiSecretKey: 'SANDBOX-KEY-' + Date.now(),
                    webhookUrl: 'https://webhook.site/sandbox', // Dummy webhook endpoint
                    lastSync: new Date()
                },
                isActive: true
            });
            console.log('✅ Enterprise Sandbox Store Created.');
        }

        // 3. Inject Foundation Categories
        const categories = ['Dairy & Breakfast', 'Snacks & Munchies', 'Cold Drinks & Juices', 'Personal Care', 'Cleaning Essentials', 'Grocery & Kitchen'];
        for (const catName of categories) {
            const catExists = await Category.findOne({ name: catName });
            if (!catExists) {
                await Category.create({ name: catName, isActive: true });
            }
        }
        console.log('✅ Base Categories Initialized.');

        console.log('\n🚀 SEED COMPLETE. Platform is ready for live traffic.');
        process.exit(0);
    } catch (error) {
        console.error('❌ SEED ERROR:', error);
        process.exit(1);
    }
}

runSeed();
