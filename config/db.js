/* config/db.js */

const mongoose = require('mongoose');

const connectDB = async (fastify) => {
    if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return true;
    let retries = 5;
    while (retries) {
        try {
            await mongoose.connect(process.env.MONGO_URI, {
                maxPoolSize: 50
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
