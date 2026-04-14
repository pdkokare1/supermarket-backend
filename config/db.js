/* config/db.js */

const mongoose = require('mongoose');

const connectDB = async (fastify) => {
    if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return true;
    let retries = 5;
    while (retries) {
        try {
            await mongoose.connect(process.env.MONGO_URI, {
                // OPTIMIZATION: Configurable pool size for clustered environments
                maxPoolSize: parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) || 50,
                // OPTIMIZATION: Maintain a minimum baseline of connections to prevent cold-start latency spikes
                minPoolSize: parseInt(process.env.MONGO_MIN_POOL_SIZE, 10) || 10, 
                // OPTIMIZATION: Fail fast (5s) to trigger the retry logic instead of hanging
                serverSelectionTimeoutMS: 5000,
                
                // OPTIMIZATION: (Serverless Protection) Automatically sweep and close idle connections 
                // to prevent MongoDB Atlas from hitting max connection limits during scale-down events
                maxIdleTimeMS: 30000, // 30 seconds
                // OPTIMIZATION: Ensure network drops are detected quickly by Mongoose
                socketTimeoutMS: 45000, 
                // OPTIMIZATION: Ping the database periodically so active connections aren't dropped by firewalls
                keepAlive: true,
                keepAliveInitialDelay: 300000 
            });

            // OPTIMIZATION: Better Observability for dropped connections
            mongoose.connection.on('disconnected', () => {
                if (fastify && fastify.log) fastify.log.warn('MongoDB connection dropped. Awaiting automatic reconnection...');
            });

            if (fastify && fastify.log) {
                fastify.log.info(`Successfully connected to MongoDB Atlas by Process ${process.pid}`);
            } else {
                console.log(`Successfully connected to MongoDB Atlas by Process ${process.pid}`);
            }
            return true;
        } catch (err) {
            console.error(`CRITICAL ERROR CONNECTING TO MONGODB. Retries left: ${retries - 1}`, err.message);
            retries -= 1;
            if (retries === 0) process.exit(1);
            await new Promise(res => setTimeout(res, 5000));
        }
    }
};

module.exports = connectDB;
