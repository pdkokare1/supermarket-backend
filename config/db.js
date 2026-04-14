/* config/db.js */
'use strict';

const mongoose = require('mongoose');

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
                // OPTIMIZATION: Ping the database periodically so active connections aren't dropped by firewalls
                keepAlive: true,
                keepAliveInitialDelay: 300000 
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
            
            await new Promise(res => setTimeout(res, 5000));
        }
    }
};

module.exports = connectDB;
