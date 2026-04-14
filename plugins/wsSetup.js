/* plugins/wsSetup.js */

const User = require('../models/User');

module.exports = function (fastify) {
    let redisPubWS = null;
    let redisSubWS = null;

    const sendToClients = (messageObj) => {
        if (!fastify.websocketServer) return;
        const msgStr = JSON.stringify(messageObj);
        fastify.websocketServer.clients.forEach(function each(client) {
            if (client.readyState === 1) { 
                
                // OPTIMIZATION: Backpressure limit to prevent V8 Out-Of-Memory.
                // Discards message for this client if their network buffer exceeds 512KB.
                if (client.bufferedAmount > 1024 * 512) {
                    fastify.log.warn(`Dropping WS frame for choking client.`);
                    return; 
                }

                if (!messageObj.storeId || client.storeId === messageObj.storeId || client.isAdmin) {
                    client.send(msgStr);
                }
            }
        });
    };

    if (process.env.REDIS_URL) {
        try {
            const Redis = require('ioredis');
            // OPTIMIZATION: Configured lazyConnect and autoResubscribe to survive network blips in scalable cloud environments
            const redisConfig = {
                lazyConnect: true,
                maxRetriesPerRequest: null,
                retryStrategy: (times) => Math.min(times * 100, 3000)
            };
            
            redisPubWS = new Redis(process.env.REDIS_URL, redisConfig);
            redisSubWS = new Redis(process.env.REDIS_URL, redisConfig);
            
            redisSubWS.subscribe('POS_WS_STREAM').catch(err => fastify.log.error('Redis WS Subscribe Error:', err));
            
            redisSubWS.on('message', (channel, messageStr) => {
                if (channel === 'POS_WS_STREAM') {
                    const parsed = JSON.parse(messageStr);
                    sendToClients(parsed);
                }
            });
            
            redisSubWS.on('error', (err) => fastify.log.error('Redis Sub WS Error:', err.message));
        } catch(e) {
            fastify.log.error("Failed to initialize Redis Pub/Sub for WebSockets", e);
        }
    }

    fastify.decorate('broadcastToPOS', function (message) {
        if (redisPubWS) {
            redisPubWS.publish('POS_WS_STREAM', JSON.stringify(message)).catch(() => sendToClients(message));
        } else {
            sendToClients(message);
        }
    });

    fastify.decorate('closeAllSSE', () => {
        if (fastify.websocketServer) {
            fastify.websocketServer.clients.forEach((client) => {
                client.terminate();
            });
        }
    });
    
    fastify.decorate('closeRedisWS', async () => {
        if (redisPubWS) await redisPubWS.quit();
        if (redisSubWS) await redisSubWS.quit();
    });

    fastify.register(async function (instance) {
        instance.get('/api/ws/pos', { websocket: true }, (connection, req) => {
            const ws = connection.socket || connection; 
            
            (async () => {
                try {
                    const token = req.query.token;
                    if (!token) throw new Error('No token provided');
                    
                    const decoded = fastify.jwt.verify(token);
                    const user = await User.findById(decoded.id).select('role isActive tokenVersion storeId');
                    
                    if (!user || !user.isActive || user.tokenVersion !== decoded.tokenVersion) {
                        throw new Error('Invalid session');
                    }

                    ws.storeId = user.storeId ? user.storeId.toString() : (req.query.storeId || null);
                    ws.isAdmin = user.role === 'Admin';
                    ws.isAlive = true; 

                    ws.on('message', message => {
                        try {
                            const parsed = JSON.parse(message.toString());
                            if (parsed.type === 'PONG') {
                                ws.isAlive = true;
                                return; 
                            }
                        } catch (e) {}
                        fastify.log.info(`[WS Store: ${ws.storeId || 'Global'}] Received: ${message}`);
                    });
                    
                    ws.send(JSON.stringify({ 
                        type: 'CONNECTION_ESTABLISHED', 
                        message: 'Connected to DailyPick Real-Time Server securely',
                        storeContext: ws.storeId || 'Global'
                    }));

                } catch (err) {
                    fastify.log.warn(`WebSocket connection rejected: ${err.message}`);
                    if (ws.readyState === 1) { 
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Authentication failed' }));
                        ws.terminate();
                    }
                }
            })();
        });

        setInterval(() => {
            if (!fastify.websocketServer) return;
            fastify.websocketServer.clients.forEach((client) => {
                if (client.isAlive === false) return client.terminate();
                client.isAlive = false;
                client.send(JSON.stringify({ type: 'PING' })); 
            });
        }, 30000);
    });
};
