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
                // OPTIMIZATION: Configurable pool size for clustered environments
                maxPoolSize: parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) || 50,
                // OPTIMIZATION: Maintain a minimum baseline of connections to prevent cold-start latency spikes
                minPoolSize: parseInt(process.env.MONGO_MIN_POOL_SIZE, 10) || 10, 
                // OPTIMIZATION: Fail fast (5s) to trigger the retry logic instead of hanging
                serverSelectionTimeoutMS: 5000,
                // OPTIMIZATION: Prevent performance hits on container restart by disabling autoIndex in production
                autoIndex: process.env.NODE_ENV !== 'production',
                // OPTIMIZATION: (Serverless Protection) Automatically sweep and close idle connections 
                maxIdleTimeMS: 30000, 
                // OPTIMIZATION: Ensure network drops are detected quickly by Mongoose
                socketTimeoutMS: 45000,
                // OPTIMIZATION: Force IPv4 resolution to eliminate 2-3s cold-start latency in cloud environments
                family: 4
            });

            // OPTIMIZATION: Better Observability for dropped connections
            mongoose.connection.on('disconnected', () => {
                logger.warn('MongoDB connection dropped. Awaiting automatic reconnection...');
            });

            logger.info(`Successfully connected to MongoDB Atlas by Process ${process.pid}`);
            
            return true;
        } catch (err) {
            logger.error(`CRITICAL ERROR CONNECTING TO MONGODB. Retries left: ${retries - 1} - ${err.message}`);
            retries -= 1;
            
            if (retries === 0) {
                logger.error('Database connection failed entirely. Triggering container restart.');
                process.exit(1);
            }
            
            // OPTIMIZATION: Exponential backoff instead of a flat 5000ms delay.
            // Spacing grows sequentially to allow MongoDB cloud clusters to restart gracefully.
            const backoffDelay = 5000 * Math.pow(2, (4 - retries));
            await new Promise(res => setTimeout(res, backoffDelay));
        }
    }
};

module.exports = connectDB;
