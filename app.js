/* app.js */
'use strict';

const path = require('path');
const os = require('os');
const v8 = require('v8');
const { monitorEventLoopDelay } = require('perf_hooks');
const Fastify = require('fastify');
const fp = require('fastify-plugin'); 
const initRedis = require('./config/redis'); 
const cacheUtils = require('./utils/cacheUtils');
const mongoose = require('mongoose'); 
const threatDefenseService = require('./services/threatDefenseService');

// OPTIMIZATION: Initialize Native Event Loop Monitor to catch CPU choking
const hld = monitorEventLoopDelay({ resolution: 10 });
hld.enable();

const createApp = (opts = {}) => {
    const isProduction = process.env.NODE_ENV === 'production';
    
    const fastify = Fastify({
        logger: isProduction ? { 
            level: 'info',
            stream: require('pino').destination({ sync: false, minLength: 4096 }),
            redact: ['req.headers.authorization', 'req.headers.cookie'] 
        } : {
            transport: {
                target: 'pino-pretty',
                options: {
                    translateTime: 'HH:MM:ss Z',
                    ignore: 'pid,hostname'
                }
            }
        },
        requestIdHeader: 'x-correlation-id',
        trustProxy: process.env.TRUST_PROXY_HOPS ? parseInt(process.env.TRUST_PROXY_HOPS, 10) : 1,
        disableRequestLogging: isProduction,
        ignoreTrailingSlash: true,
        bodyLimit: process.env.BODY_LIMIT || 1048576, 
        connectionTimeout: process.env.CONNECTION_TIMEOUT || 10000, 
        keepAliveTimeout: process.env.KEEP_ALIVE_TIMEOUT || 5000,
        ajv: {
            customOptions: {
                removeAdditional: 'all',
                coerceTypes: true,
                useDefaults: true
            }
        },
        ...opts
    });

    const redisClient = initRedis();

    if (redisClient) {
        redisClient.on('error', (err) => fastify.log.error(`Redis Client Error: ${err.message}`));
        redisClient.on('connect', () => fastify.log.info('Redis Client successfully connected'));
        redisClient.on('reconnecting', () => fastify.log.warn('Redis Client is reconnecting to the server'));
    }
    
    cacheUtils.setClient(redisClient);
    
    fastify.register(fp(async (instance) => {
        instance.decorate('redis', redisClient);
    }));

    // ==========================================
    // --- CORE SYSTEM ROUTES (Bypassing Autoloader) ---
    // ==========================================

    fastify.get('/api/health', async (request, reply) => {
        return reply.code(200).send({ status: 'Healthy', uptime: process.uptime() });
    });

    fastify.get('/', async (request, reply) => {
        return { 
            status: 'Active',
            message: 'DailyPick Fastify Backend MVP is running and connected!' 
        };
    });

    fastify.get('/api/system/unban', async (request, reply) => {
        await threatDefenseService.clearLockout(request.ip, 'system_unban');
        return { success: true, message: `IP ${request.ip} has been successfully removed from the blocklist.` };
    });

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

    // ==========================================
    // --- MODULAR PLUGINS & AUTOLOADER ---
    // ==========================================
    
    const corePlugins = ['securitySetup', 'middlewareSetup', 'apiDocsSetup', 'eventsSetup', 'authSetup', 'wsSetup', 'loadSheddingSetup', 'errorHandler'];
    corePlugins.forEach(plugin => require(`./plugins/${plugin}`)(fastify));

    fastify.register(require('@fastify/autoload'), {
        dir: path.join(__dirname, 'routes')
    });

    return { fastify, redisClient };
};

module.exports = createApp;
