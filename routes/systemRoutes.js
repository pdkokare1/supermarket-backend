/* routes/systemRoutes.js */

const os = require('os');
const mongoose = require('mongoose');

module.exports = async function (fastify, options) {
    const { redisClient } = options;

    fastify.get('/api/inventory/report', async (request, reply) => {
        if (redisClient) {
            try {
                const cachedReport = await redisClient.get('cache:inventory:report');
                if (cachedReport) {
                    return { success: true, data: JSON.parse(cachedReport), cached: true };
                }
            } catch (e) {
                fastify.log.error('Redis Cache Read Error:', e);
            }
        }

        // Fallback structure if Redis is empty or down
        return { success: true, data: { lowStock: [], deadStock: [], lastGenerated: null }, cached: false };
    });

    fastify.get('/api/health', async (request, reply) => {
        const dbStatus = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
        let redisStatus = 'Not Configured';
        
        if (redisClient) {
            try {
                await redisClient.ping();
                redisStatus = 'Connected';
            } catch (e) {
                redisStatus = 'Disconnected';
            }
        }
        
        const memoryUsage = process.memoryUsage();
        const systemHealth = {
            status: dbStatus === 'Connected' ? 'Healthy' : 'Error',
            database: dbStatus,
            redis: redisStatus,
            uptime: process.uptime(),
            memory: {
                free: `${(os.freemem() / 1024 / 1024).toFixed(2)} MB`,
                total: `${(os.totalmem() / 1024 / 1024).toFixed(2)} MB`,
                rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`
            },
            cpuLoad: os.loadavg()
        };
        
        if (dbStatus !== 'Connected') {
            reply.status(503).send(systemHealth);
        } else {
            reply.send(systemHealth);
        }
    });

    fastify.get('/', async (request, reply) => {
        return { 
            status: 'Active',
            message: 'Supermarket Fastify Backend MVP is running and connected!' 
        };
    });
};
