/* routes/systemRoutes.js */
'use strict';

const os = require('os');
const v8 = require('v8'); 
const mongoose = require('mongoose');
const { monitorEventLoopDelay } = require('perf_hooks');

// OPTIMIZATION: Initialize Native Event Loop Monitor to catch CPU choking
const hld = monitorEventLoopDelay({ resolution: 10 });
hld.enable();

module.exports = async function (fastify, options) {
    const redisClient = fastify.redis;

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
        return { success: true, data: { lowStock: [], deadStock: [], lastGenerated: null }, cached: false };
    });

    // OPTIMIZATION: Shifted deep structural health checks to a dedicated metrics endpoint.
    // Preserves advanced diagnostics safely without interfering with Railway's mandatory startup pings.
    fastify.get('/api/system/metrics', async (request, reply) => {
        if (fastify.isShuttingDown) {
            return reply.status(503).send({ status: 'Shutting Down', message: 'Container is draining traffic.' });
        }

        const eventLoopLag = hld.mean / 1e6; 
        const isCpuOverloaded = eventLoopLag > 100; 

        const heapStats = v8.getHeapStatistics();
        const heapUsedPercentage = (heapStats.used_heap_size / heapStats.heap_size_limit) * 100;
        const isMemoryOverloaded = heapUsedPercentage > 85; 

        const dbStatus = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
        let redisStatus = 'Not Configured';
        
        if (redisClient) {
            try {
                // Prevent Redis ping from freezing the response if offline by wrapping it in a 1-second timeout
                await Promise.race([
                    redisClient.ping(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 1000))
                ]);
                redisStatus = 'Connected';
            } catch (e) {
                redisStatus = 'Disconnected';
            }
        }
        
        const memoryUsage = process.memoryUsage();
        const systemHealth = {
            status: (dbStatus === 'Connected' && !isCpuOverloaded && !isMemoryOverloaded) ? 'Healthy' : 'Degraded',
            database: dbStatus,
            redis: redisStatus,
            uptime: process.uptime(),
            eventLoopLag: `${eventLoopLag.toFixed(2)} ms`,
            memory: {
                free: `${(os.freemem() / 1024 / 1024).toFixed(2)} MB`,
                total: `${(os.totalmem() / 1024 / 1024).toFixed(2)} MB`,
                rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
                v8HeapUsed: `${(heapStats.used_heap_size / 1024 / 1024).toFixed(2)} MB`,
                v8HeapLimit: `${(heapStats.heap_size_limit / 1024 / 1024).toFixed(2)} MB`,
                heapUsagePercent: `${heapUsedPercentage.toFixed(2)}%`
            },
            cpuLoad: os.loadavg()
        };
        
        if (systemHealth.status !== 'Healthy') {
            return reply.status(503).send(systemHealth);
        } 
        return reply.send(systemHealth);
    });

    fastify.get('/', async (request, reply) => {
        return { 
            status: 'Active',
            message: 'DailyPick Fastify Backend MVP is running and connected!' 
        };
    });
};
