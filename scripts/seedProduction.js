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

// ============================================================================
// --- NEW: PHASE 15 PLATFORM STORE & GLOBAL SETTINGS SEED ---
// ============================================================================
const _originalSeedExit = process.exit;
let _hasRunPhase15Seed = false;

process.exit = function(code) {
    if (code === 0 && !_hasRunPhase15Seed) {
        _hasRunPhase15Seed = true;
        (async () => {
            try {
                console.log('🌱 Initiating Phase 15 Core Configuration Seed...');
                const Settings = require('../models/Settings');

                // 1. Create the Default "DailyPick Platform" Store
                const platformStoreExists = await Store.findOne({ name: 'DailyPick Platform' });
                if (!platformStoreExists) {
                    await Store.create({
                        name: 'DailyPick Platform',
                        location: 'Global HQ',
                        storeType: 'PLATFORM',
                        fulfillmentOptions: ['INSTANT_DELIVERY', 'ROUTINE_DELIVERY'],
                        isActive: true
                    });
                    console.log('✅ Default Platform Store Created.');
                }

                // 2. Initialize Global Economics Settings
                const settingsExist = await Settings.findOne({ key: 'GLOBAL_ECONOMICS' });
                if (!settingsExist) {
                    await Settings.create({
                        key: 'GLOBAL_ECONOMICS',
                        value: {
                            deliveryFeeRs: 20,
                            platformCommissionPct: 2.5,
                            loyaltyEarnRatePct: 1.0,
                            surgeMultiplier: 1.0
                        }
                    });
                    console.log('✅ Global Economics Settings Initialized.');
                }

                console.log('🚀 PHASE 15 SEED COMPLETE.');
                _originalSeedExit(0);
            } catch (err) {
                console.error('Phase 15 Seed Error:', err);
                _originalSeedExit(1);
            }
        })();
    } else {
        _originalSeedExit(code);
    }
};
