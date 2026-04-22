/* config/db.js */
'use strict';

const mongoose = require('mongoose');

// OPTIMIZATION: Enforce strict schema filtering globally to prevent NoSQL Injection attacks.
mongoose.set('strictQuery', true);

const connectDB = async (fastify) => {
    if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return true;
    
    let retries = 5;
    const logger = fastify && fastify.log ? fastify.log : console;

    while (retries) {
        try {
            await mongoose.connect(process.env.MONGO_URI, {
                maxPoolSize: parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) || 50,
                minPoolSize: parseInt(process.env.MONGO_MIN_POOL_SIZE, 10) || 10, 
                serverSelectionTimeoutMS: 5000,
                autoIndex: process.env.NODE_ENV !== 'production',
                maxIdleTimeMS: 30000, 
                socketTimeoutMS: 45000,
                // OPTIMIZATION: Prevents load balancers from silently dropping idle TCP connections
                keepAliveInitialDelay: 300000,
                family: 4
            });

            // OPTIMIZATION: Complete Lifecycle Observability
            mongoose.connection.on('disconnected', () => logger.warn('MongoDB connection dropped. Awaiting automatic reconnection...'));
            mongoose.connection.on('reconnected', () => logger.info('MongoDB successfully reconnected.'));
            mongoose.connection.on('error', (err) => logger.error(`MongoDB Connection Error: ${err.message}`));

            logger.info(`Successfully connected to MongoDB Atlas by Process ${process.pid}`);
            
            return true;
        } catch (err) {
            logger.error(`CRITICAL ERROR CONNECTING TO MONGODB. Retries left: ${retries - 1} - ${err.message}`);
            retries -= 1;
            
            if (retries === 0) {
                logger.error('Database connection failed entirely. Triggering container restart.');
                process.exit(1);
            }
            
            const backoffDelay = 5000 * Math.pow(2, (4 - retries));
            await new Promise(res => setTimeout(res, backoffDelay));
        }
    }
};

module.exports = connectDB;
