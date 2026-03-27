/* plugins/wsSetup.js */

const User = require('../models/User');

module.exports = function (fastify) {
    let redisPubWS = null;
    let redisSubWS = null;

    if (process.env.REDIS_URL) {
        try {
            const Redis = require('ioredis');
            redisPubWS = new Redis(process.env.REDIS_URL);
            redisSubWS = new Redis(process.env.REDIS_URL);
            
            redisSubWS.subscribe('POS_WS_STREAM');
            redisSubWS.on('message', (channel, messageStr) => {
                if (channel === 'POS_WS_STREAM' && fastify.websocketServer) {
                    const parsed = JSON.parse(messageStr);
                    fastify.websocketServer.clients.forEach(function each(client) {
                        if (client.readyState === 1) { 
                            if (!parsed.storeId || client.storeId === parsed.storeId || client.isAdmin) {
                                client.send(JSON.stringify(parsed));
                            }
                        }
                    });
                }
            });
        } catch(e) {
            fastify.log.error("Failed to initialize Redis Pub/Sub for WebSockets", e);
        }
    }

    fastify.decorate('broadcastToPOS', function (message) {
        if (redisPubWS) {
            redisPubWS.publish('POS_WS_STREAM', JSON.stringify(message));
        } else {
            if (!fastify.websocketServer) return;
            fastify.websocketServer.clients.forEach(function each(client) {
                if (client.readyState === 1) { 
                    if (!message.storeId || client.storeId === message.storeId || client.isAdmin) {
                        client.send(JSON.stringify(message));
                    }
                }
            });
        }
    });

    fastify.decorate('closeAllSSE', () => {
        if (fastify.websocketServer) {
            fastify.websocketServer.clients.forEach((client) => {
                client.terminate();
            });
        }
    });
    
    // Safety feature attached to allow server.js to shut down Redis gracefully
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
