/* server.js */
'use strict';

const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = require('./config/db');
const { handleInventoryReport } = require('./jobs/inventoryHandler'); 
const { bootstrapServer } = require('./utils/serverProcessUtils');
const createApp = require('./app');

const { fastify, redisClient } = createApp();
const PORT = process.env.PORT || 3000;

// ==========================================
// --- INITIALIZATION HELPERS ---
// ==========================================

const initScheduler = () => {
    require('./jobs/cronScheduler')(fastify, (newReport) => 
        handleInventoryReport(redisClient, fastify, newReport)
    );
};

const startServer = async () => {
    await connectDB(fastify);
    require('./jobs/backupCron')(fastify); 
    
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        fastify.log.info(`Server successfully bound to port ${PORT}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// ==========================================
// --- EXECUTION BOOTSTRAP ---
// ==========================================

bootstrapServer(fastify, redisClient, PORT, connectDB, initScheduler, startServer);
