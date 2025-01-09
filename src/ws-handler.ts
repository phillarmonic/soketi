import { App } from './app';
import async from 'async';
import { EncryptedPrivateChannelManager } from './channels';
import { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { Log } from './log';
import { Namespace } from './namespace';
import { PresenceChannelManager } from './channels';
import { PresenceMemberInfo } from './channels/presence-channel-manager';
import { PrivateChannelManager } from './channels';
import { PublicChannelManager } from './channels';
import { PusherMessage, uWebSocketMessage } from './message';
import { Server } from './server';
import { Utils } from './utils';
import { WebSocket } from 'uWebSockets.js';
import { PusherToken } from './utils/pusher-token';
import { getClientIp, getIpInfo } from './utils/ip';
import Pusher from 'pusher';

export class WsHandler {
    /**
     * The manager for the public channels.
     */
    protected publicChannelManager: PublicChannelManager;

    /**
     * The manager for the private channels.
     */
    protected privateChannelManager: PrivateChannelManager;

    /**
     * The manager for the encrypted private channels.
     */
    protected encryptedPrivateChannelManager: EncryptedPrivateChannelManager;

    /**
     * The manager for the presence channels.
     */
    protected presenceChannelManager: PresenceChannelManager;

    /**
     * Initialize the Websocket connections handler.
     */
    constructor(protected server: Server) {
        this.publicChannelManager = new PublicChannelManager(server);
        this.privateChannelManager = new PrivateChannelManager(server);
        this.encryptedPrivateChannelManager = new EncryptedPrivateChannelManager(server);
        this.presenceChannelManager = new PresenceChannelManager(server);
        Log.setDebugMode(this.server.options.debug);
    }

    /**
     * Handle a new open connection.
     */
    onOpen(ws: WebSocket): any {
        Log.connectionLifecycle('Connection attempt started', 'start');

        if (this.server.options.debug) {
            Log.websocketTitle('👨‍🔬 New connection:');
            Log.websocket({ ws });

            if (ws.headers) {
                Log.websocketTitle('📝 Connection Headers:');
                Log.websocket({ headers: ws.headers });
            } else {
                Log.websocketTitle('No headers captured during upgrade.');
            }
        }

        ws.sendJson = (data) => {
            try {
                Log.debug('Attempting to send message', 'WS');
                ws.send(JSON.stringify(data));
                this.updateTimeout(ws);

                if (ws.app) {
                    this.server.metricsManager.markWsMessageSent(ws.app.id, data);
                }

                Log.debug(`Message sent successfully: ${JSON.stringify(data)}`, 'WS');
            } catch (e) {
                Log.debug(`Failed to send message: ${e.message}`, 'WS');
            }
        }

        ws.id = this.generateSocketId();
        ws.subscribedChannels = new Set();
        ws.presence = new Map<string, PresenceMemberInfo>();

        Log.debug(`Generated socket ID: ${ws.id}`, 'WS');

        // Send immediate socket ID response
        ws.sendJson({
            event: 'socket_id',
            data: {
                socket_id: ws.id
            }
        });

        if (this.server.closing) {
            Log.connectionLifecycle('Server is closing - rejecting connection', 'error');
            ws.sendJson({
                event: 'pusher:error',
                data: {
                    code: 4200,
                    message: 'Server is closing. Please reconnect shortly.',
                },
            });
            return ws.end(4200);
        }

        this.checkForValidApp(ws).then(validApp => {
            if (!validApp) {
                Log.connectionLifecycle(`Invalid app key: ${ws.appKey}`, 'error');
                ws.sendJson({
                    event: 'pusher:error',
                    data: {
                        code: 4001,
                        message: `App key ${ws.appKey} does not exist.`,
                    },
                });
                return ws.end(4001);
            }

            Log.debug(`Valid app found for key: ${ws.appKey}`, 'WS');
            ws.app = validApp.forWebSocket();

            this.checkIfAppIsEnabled(ws).then(enabled => {
                if (!enabled) {
                    Log.connectionLifecycle('App is disabled', 'error');
                    ws.sendJson({
                        event: 'pusher:error',
                        data: {
                            code: 4003,
                            message: 'The app is not enabled.',
                        },
                    });
                    return ws.end(4003);
                }

                this.checkAppConnectionLimit(ws).then(canConnect => {
                    if (!canConnect) {
                        Log.connectionLifecycle('Connection limit reached', 'error');
                        ws.sendJson({
                            event: 'pusher:error',
                            data: {
                                code: 4100,
                                message: 'The current concurrent connections quota has been reached.',
                            },
                        });
                        ws.end(4100);
                    } else {
                        Log.debug('Adding socket to adapter', 'WS');
                        this.server.adapter.addSocket(ws.app.id, ws);

                        let broadcastMessage = {
                            event: 'pusher:connection_established',
                            data: JSON.stringify({
                                socket_id: ws.id,
                                activity_timeout: 30,
                            }),
                        };

                        Log.connectionLifecycle('Connection established successfully', 'success');
                        ws.sendJson(broadcastMessage);

                        if (ws.app.enableUserAuthentication) {
                            Log.debug('Setting user authentication timeout', 'WS');
                            this.setUserAuthenticationTimeout(ws);
                        }

                        this.server.metricsManager.markNewConnection(ws);
                    }
                });
            });
        });
    }
    /**
     * Handle a received message from the client.
     */
    onMessage(ws: WebSocket, message: uWebSocketMessage, isBinary: boolean): any {
        Log.debug('Message received', 'WS');

        if (message instanceof ArrayBuffer) {
            try {
                message = JSON.parse(ab2str(message)) as PusherMessage;
                Log.debug('Successfully parsed ArrayBuffer message', 'WS');
            } catch (err) {
                Log.debug(`Failed to parse ArrayBuffer message: ${err.message}`, 'WS');
                return;
            }
        }

        if (this.server.options.debug) {
            Log.websocketTitle('⚡ New message received:');
            Log.websocket({ message, isBinary });
        }

        if (message) {
            if (message.event === 'pusher:ping') {
                Log.debug('Received PING message', 'WS');
                this.handlePong(ws);
            } else if (message.event === 'pusher:subscribe') {
                Log.debug('Received SUBSCRIBE message', 'WS');
                this.subscribeToChannel(ws, message);
            } else if (message.event === 'pusher:unsubscribe') {
                Log.debug('Received UNSUBSCRIBE message', 'WS');
                this.unsubscribeFromChannel(ws, message.data.channel);
            } else if (Utils.isClientEvent(message.event)) {
                Log.debug('Received client-side event message', 'WS');
                this.handleClientEvent(ws, message);
            } else if (message.event === 'pusher:signin') {
                Log.debug('Received SIGNIN message', 'WS');
                this.handleSignin(ws, message);
            } else {
                Log.warning({
                    info: 'Message event handler not implemented.',
                    message,
                });
            }
        }

        if (ws.app) {
            this.server.metricsManager.markWsMessageReceived(ws.app.id, message);
        }
    }

    /**
     * Handle the event of the client closing the connection.
     */
    onClose(ws: WebSocket, code: number, message: uWebSocketMessage): any {
        Log.connectionLifecycle(`Connection closed with code ${code}`, code === 4200 ? 'info' : 'error');

        if (this.server.options.debug) {
            Log.websocketTitle('❌ Connection closed:');
            Log.websocket({ ws, code, message });
        }

        if (code !== 4200) {
            this.evictSocketFromMemory(ws);
        }
    }

    /**
     * Evict the local socket.
     */
    evictSocketFromMemory(ws: WebSocket): Promise<void> {
        // eslint-disable-next-line no-async-promise-executor
        return new Promise(async (resolve) => {
            try {
                await this.unsubscribeFromAllChannels(ws, true);

                if (ws.app) {
                    await this.server.adapter.removeSocket(ws.app.id, ws.id);
                    this.server.metricsManager.markDisconnection(ws);
                }

                // Clear all timeouts and intervals
                this.clearTimeout(ws);
                if (ws.userAuthenticationTimeout) {
                    clearTimeout(ws.userAuthenticationTimeout);
                    ws.userAuthenticationTimeout = null;
                }

                // Clear circular references
                ws.subscribedChannels = null;
                ws.presence = null;
                ws.app = null;
                ws.user = null;

                resolve();
            } catch (err) {
                Log.error(`Error during socket eviction: ${err.message}`);
                resolve(); // Still resolve to continue cleanup
            }
        });
    }

    /**
     * Handle the event to close all existing sockets.
     */
    async closeAllLocalSockets(): Promise<void> {
        Log.debug('Starting closeAllLocalSockets process', 'Cleanup');
        let namespaces = this.server.adapter.getNamespaces();

        if (namespaces.size === 0) {
            Log.debug('No namespaces found, cleanup complete', 'Cleanup');
            return Promise.resolve();
        }

        try {
            await async.each([...namespaces], async ([namespaceId, namespace]: [string, Namespace]) => {
                Log.debug(`Processing namespace: ${namespaceId}`, 'Cleanup');
                const sockets = await namespace.getSockets();

                await async.each([...sockets], async ([wsId, ws]: [string, WebSocket]) => {
                    try {
                        // Create a sanitized version of the error message
                        const errorMessage = {
                            event: 'pusher:error',
                            data: {
                                code: 4200,
                                message: 'Server closed. Please reconnect shortly.',
                            },
                        };

                        Log.debug(`Closing socket: ${wsId}`, 'Cleanup');
                        ws.sendJson(errorMessage);
                        ws.end(4200);
                    } catch (e) {
                        Log.error(`Failed to close socket ${wsId}: ${e.message}`);
                    }

                    await this.evictSocketFromMemory(ws);
                });

                Log.debug(`Clearing namespace: ${namespaceId}`, 'Cleanup');
                await this.server.adapter.clearNamespace(namespaceId);
            });

            // Final cleanup
            Log.debug('Performing final namespace cleanup', 'Cleanup');
            await this.server.adapter.clearNamespaces();
            Log.debug('Cleanup process complete', 'Cleanup');
        } catch (err) {
            Log.error(`Cleanup process failed: ${err.message}`);
            // Re-throw to maintain error propagation
            throw err;
        }
    }

    /**
     * Mutate the upgrade request.
     */
    handleUpgrade(res: HttpResponse, req: HttpRequest, context): any {
        const ipInfo = getIpInfo(req, res);

        // Collect all headers during upgrade
        const headers: {[key: string]: string} = {};
        req.forEach((key: string, value: string) => {
            headers[key] = value;
        });

        res.upgrade(
            {
                ip: ipInfo.clientIp,
                originalIp: ipInfo.originalIp,
                proxyIp: ipInfo.proxyIp,
                forwardedIps: ipInfo.forwardedIps,
                appKey: req.getParameter(0),
                headers: headers, // Pass collected headers to the WebSocket
            },
            req.getHeader('sec-websocket-key'),
            req.getHeader('sec-websocket-protocol'),
            req.getHeader('sec-websocket-extensions'),
            context,
        );
    }


    /**
     * Send back the pong response.
     */
    handlePong(ws: WebSocket): any {
        Log.debug('Received ping, sending pong response', 'WS');
        ws.sendJson({
            event: 'pusher:pong'
        });

        if (this.server.closing) {
            Log.connectionLifecycle('Server closing during pong - terminating connection', 'error');
            ws.sendJson({
                event: 'pusher:error',
                data: {
                    code: 4200,
                    message: 'Server closed. Please reconnect shortly.',
                },
            });

            ws.end(4200);
            this.evictSocketFromMemory(ws);
        }
    }

    /**
     * Instruct the server to subscribe the connection to the channel.
     */
    subscribeToChannel(ws: WebSocket, message: PusherMessage): any {
        Log.debug(`Subscription request received for channel: ${message.data.channel}`, 'WS');

        if (this.server.closing) {
            Log.connectionLifecycle('Server closing during subscription - terminating', 'error');
            ws.sendJson({
                event: 'pusher:error',
                data: {
                    code: 4200,
                    message: 'Server closed. Please reconnect shortly.',
                },
            });

            ws.end(4200);
            this.evictSocketFromMemory(ws);
            return;
        }

        let channel = message.data.channel;
        let channelManager = this.getChannelManagerFor(channel);
        Log.debug(`Using channel manager: ${channelManager.constructor.name}`, 'WS');

        if (channel.length > ws.app.maxChannelNameLength) {
            Log.debug('Channel name exceeds maximum length', 'WS');
            ws.sendJson({
                event: 'pusher:subscription_error',
                channel,
                data: {
                    type: 'LimitReached',
                    error: `The channel name is longer than the allowed ${ws.app.maxChannelNameLength} characters.`,
                    status: 4009,
                },
            });
            return;
        }

        channelManager.join(ws, channel, message).then((response) => {
            Log.debug(`Channel join response received: ${JSON.stringify(response)}`, 'WS');

            if (!response.success) {
                let { authError, type, errorMessage, errorCode } = response;
                Log.connectionLifecycle(`Subscription failed: ${errorMessage}`, 'error');

                if (authError) {
                    return ws.sendJson({
                        event: 'pusher:subscription_error',
                        channel,
                        data: {
                            type: 'AuthError',
                            error: errorMessage,
                            status: 401,
                        },
                    });
                }

                return ws.sendJson({
                    event: 'pusher:subscription_error',
                    channel,
                    data: {
                        type: type,
                        error: errorMessage,
                        status: errorCode,
                    },
                });
            }

            if (!ws.subscribedChannels.has(channel)) {
                Log.debug(`Adding channel ${channel} to subscribed channels`, 'WS');
                ws.subscribedChannels.add(channel);
            }

            this.server.adapter.addSocket(ws.app.id, ws);

            if (response.channelConnections === 1) {
                Log.debug('First connection to channel - sending occupied webhook', 'WS');
                this.server.webhookSender.sendChannelOccupied(ws.app, channel);
            }

            if (!(channelManager instanceof PresenceChannelManager)) {
                Log.debug('Sending subscription success for non-presence channel', 'WS');
                let broadcastMessage = {
                    event: 'pusher_internal:subscription_succeeded',
                    channel,
                };

                ws.sendJson(broadcastMessage);

                if (Utils.isCachingChannel(channel)) {
                    this.sendMissedCacheIfExists(ws, channel);
                }

                Log.connectionLifecycle(`Successfully subscribed to channel: ${channel}`, 'success');
                return;
            }

            Log.debug('Processing presence channel subscription', 'WS');
            this.server.adapter.getChannelMembers(ws.app.id, channel, false).then(members => {
                let { user_id, user_info } = response.member;
                ws.presence.set(channel, response.member);
                this.server.adapter.addSocket(ws.app.id, ws);

                if (!members.has(user_id as string)) {
                    Log.debug(`Adding new member ${user_id} to presence channel`, 'WS');
                    this.server.webhookSender.sendMemberAdded(ws.app, channel, user_id as string);

                    this.server.adapter.send(ws.app.id, channel, JSON.stringify({
                        event: 'pusher_internal:member_added',
                        channel,
                        data: JSON.stringify({
                            user_id: user_id,
                            user_info: user_info,
                        }),
                    }), ws.id);

                    members.set(user_id as string, user_info);
                }

                let broadcastMessage = {
                    event: 'pusher_internal:subscription_succeeded',
                    channel,
                    data: JSON.stringify({
                        presence: {
                            ids: Array.from(members.keys()),
                            hash: Object.fromEntries(members),
                            count: members.size,
                        },
                    }),
                };

                ws.sendJson(broadcastMessage);

                if (Utils.isCachingChannel(channel)) {
                    this.sendMissedCacheIfExists(ws, channel);
                }

                Log.connectionLifecycle(`Successfully subscribed to presence channel: ${channel}`, 'success');
            }).catch(err => {
                Log.error(err);
                Log.connectionLifecycle(`Server error during presence subscription: ${err.message}`, 'error');

                ws.sendJson({
                    event: 'pusher:error',
                    channel,
                    data: {
                        type: 'ServerError',
                        error: 'A server error has occured.',
                        code: 4302,
                    },
                });
            });
        });
    }
    /**
     * Instruct the server to unsubscribe the connection from the channel.
     */
    unsubscribeFromChannel(ws: WebSocket, channel: string, closing = false): Promise<void> {
        let channelManager = this.getChannelManagerFor(channel);

        return channelManager.leave(ws, channel).then(response => {
            let member = ws.presence.get(channel);

            if (response.left) {
                // Send presence channel-speific events and delete specific data.
                // This can happen only if the user is connected to the presence channel.
                if (channelManager instanceof PresenceChannelManager && ws.presence.has(channel)) {
                    ws.presence.delete(channel);

                    // Make sure to update the socket after new data was pushed in.
                    this.server.adapter.addSocket(ws.app.id, ws);

                    this.server.adapter.getChannelMembers(ws.app.id, channel, false).then(members => {
                        if (!members.has(member.user_id as string)) {
                            this.server.webhookSender.sendMemberRemoved(ws.app, channel, member.user_id);

                            this.server.adapter.send(ws.app.id, channel, JSON.stringify({
                                event: 'pusher_internal:member_removed',
                                channel,
                                data: JSON.stringify({
                                    user_id: member.user_id,
                                }),
                            }), ws.id);
                        }
                    });
                }

                ws.subscribedChannels.delete(channel);

                // Make sure to update the socket after new data was pushed in,
                // but only if the user is not closing the connection.
                if (!closing) {
                    this.server.adapter.addSocket(ws.app.id, ws);
                }

                if (response.remainingConnections === 0) {
                    this.server.webhookSender.sendChannelVacated(ws.app, channel);
                }
            }

            // ws.send(JSON.stringify({
            //     event: 'pusher_internal:unsubscribed',
            //     channel,
            // }));

            return;
        });
    }

    /**
     * Unsubscribe the connection from all channels.
     */
    unsubscribeFromAllChannels(ws: WebSocket, closing = true): Promise<void> {
        if (!ws.subscribedChannels) {
            return Promise.resolve();
        }

        return Promise.all([
            async.each(ws.subscribedChannels, (channel, callback) => {
                this.unsubscribeFromChannel(ws, channel, closing).then(() => callback());
            }),
            ws.app && ws.user ? this.server.adapter.removeUser(ws) : new Promise<void>(resolve => resolve()),
        ]).then(() => {
            return;
        })
    }

    /**
     * Handle the events coming from the client.
     */
    handleClientEvent(ws: WebSocket, message: PusherMessage): any {
        let { event, data, channel } = message;

        if (!ws.app.enableClientMessages) {
            return ws.sendJson({
                event: 'pusher:error',
                channel,
                data: {
                    code: 4301,
                    message: `The app does not have client messaging enabled.`,
                },
            });
        }

        // Make sure the event name length is not too big.
        if (event.length > ws.app.maxEventNameLength) {
            let broadcastMessage = {
                event: 'pusher:error',
                channel,
                data: {
                    code: 4301,
                    message: `Event name is too long. Maximum allowed size is ${ws.app.maxEventNameLength}.`,
                },
            };

            ws.sendJson(broadcastMessage);

            return;
        }

        let payloadSizeInKb = Utils.dataToKilobytes(message.data);

        // Make sure the total payload of the message body is not too big.
        if (payloadSizeInKb > parseFloat(ws.app.maxEventPayloadInKb as string)) {
            let broadcastMessage = {
                event: 'pusher:error',
                channel,
                data: {
                    code: 4301,
                    message: `The event data should be less than ${ws.app.maxEventPayloadInKb} KB.`,
                },
            };

            ws.sendJson(broadcastMessage);

            return;
        }

        this.server.adapter.isInChannel(ws.app.id, channel, ws.id).then(canBroadcast => {
            if (!canBroadcast) {
                return;
            }

            this.server.rateLimiter.consumeFrontendEventPoints(1, ws.app, ws).then(response => {
                if (response.canContinue) {
                    let userId = ws.presence.has(channel) ? ws.presence.get(channel).user_id : null;

                    let message = JSON.stringify({
                        event,
                        channel,
                        data,
                        ...userId ? { user_id: userId } : {},
                    });

                    this.server.adapter.send(ws.app.id, channel, message, ws.id);

                    this.server.webhookSender.sendClientEvent(
                        ws.app, channel, event, data, ws.id, userId,
                    );

                    return;
                }

                ws.sendJson({
                    event: 'pusher:error',
                    channel,
                    data: {
                        code: 4301,
                        message: 'The rate limit for sending client events exceeded the quota.',
                    },
                });
            });
        });
    }

    /**
     * Handle the signin coming from the frontend.
     */
    handleSignin(ws: WebSocket, message: PusherMessage): void {
        if (!ws.userAuthenticationTimeout) {
            return;
        }

        this.signinTokenIsValid(ws, message.data.user_data, message.data.auth).then(isValid => {
            if (!isValid) {
                ws.sendJson({
                    event: 'pusher:error',
                    data: {
                        code: 4009,
                        message: 'Connection not authorized.',
                    },
                });

                try {
                    ws.end(4009);
                } catch (e) {
                    //
                }

                return;
            }

            let decodedUser = JSON.parse(message.data.user_data);

            if (!decodedUser.id) {
                ws.sendJson({
                    event: 'pusher:error',
                    data: {
                        code: 4009,
                        message: 'The returned user data must contain the "id" field.',
                    },
                });

                try {
                    ws.end(4009);
                } catch (e) {
                    //
                }

                return;
            }

            ws.user = {
                ...decodedUser,
                ...{
                    id: decodedUser.id.toString(),
                },
            };

            if (ws.userAuthenticationTimeout) {
                clearTimeout(ws.userAuthenticationTimeout);
            }

            this.server.adapter.addSocket(ws.app.id, ws);

            this.server.adapter.addUser(ws).then(() => {
                ws.sendJson({
                    event: 'pusher:signin_success',
                    data: message.data,
                });
            });
        });
    }

    /**
     * Send the first event as cache_missed, if it exists, to catch up.
     */
    sendMissedCacheIfExists(ws: WebSocket, channel: string) {
        this.server.cacheManager.get(`app:${ws.app.id}:channel:${channel}:cache_miss`).then(cachedEvent => {
            if (cachedEvent) {
                let { event, data } = JSON.parse(cachedEvent);
                ws.sendJson({ event: event, channel, data: data });
            } else {
                ws.sendJson({ event: 'pusher:cache_miss', channel });
                this.server.webhookSender.sendCacheMissed(ws.app, channel);
            }
        });
    }

    /**
     * Get the channel manager for the given channel name,
     * respecting the Pusher protocol.
     */
    getChannelManagerFor(channel: string): PublicChannelManager|PrivateChannelManager|EncryptedPrivateChannelManager|PresenceChannelManager {
        if (Utils.isPresenceChannel(channel)) {
            return this.presenceChannelManager;
        } else if (Utils.isEncryptedPrivateChannel(channel)) {
            return this.encryptedPrivateChannelManager;
        } else if (Utils.isPrivateChannel(channel)) {
            return this.privateChannelManager;
        } else {
            return this.publicChannelManager;
        }
    }

    /**
     * Use the app manager to retrieve a valid app.
     */
    protected checkForValidApp(ws: WebSocket): Promise<App|null> {
        return this.server.appManager.findByKey(ws.appKey);
    }

    /**
     * Make sure that the app is enabled.
     */
    protected checkIfAppIsEnabled(ws: WebSocket): Promise<boolean> {
        return Promise.resolve(ws.app.enabled);
    }

    /**
     * Make sure the connection limit is not reached with this connection.
     * Return a boolean wether the user can connect or not.
     */
    protected checkAppConnectionLimit(ws: WebSocket): Promise<boolean> {
        return this.server.adapter.getSocketsCount(ws.app.id).then(wsCount => {
            let maxConnections = parseInt(ws.app.maxConnections as string) || -1;

            if (maxConnections < 0) {
                return true;
            }

            return wsCount + 1 <= maxConnections;
        }).catch(err => {
            Log.error(err);
            return false;
        });
    }

    /**
     * Check is an incoming connection can subscribe.
     */
    signinTokenIsValid(ws: WebSocket, userData: string, signatureToCheck: string): Promise<boolean> {
        return this.signinTokenForUserData(ws, userData).then(expectedSignature => {
            return signatureToCheck === expectedSignature;
        });
    }

    /**
     * Get the signin token from the given message, by the Socket.
     */
    protected signinTokenForUserData(ws: WebSocket, userData: string): Promise<string> {
        return new Promise(resolve => {
            const decodedString = `${ws.id}::user::${userData}`;
            const token = new PusherToken(ws.app.key, ws.app.secret);

            resolve(token.generateAuthSignature(decodedString));
        });
    }

    /**
     * Generate a Pusher-like Socket ID.
     */
    protected generateSocketId(): string {
        let min = 0;
        let max = 10000000000;

        let randomNumber = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

        return randomNumber(min, max) + '.' + randomNumber(min, max);
    }

    /**
     * Clear WebSocket timeout.
     */
    protected clearTimeout(ws: WebSocket): void {
        if (ws.timeout) {
            clearTimeout(ws.timeout);
        }
    }

    /**
     * Update WebSocket timeout.
     */
    protected updateTimeout(ws: WebSocket): void {
        this.clearTimeout(ws);

        ws.timeout = setTimeout(() => {
            try {
                ws.end(4201);
            } catch (e) {
                //
            }
        }, 120_000);
    }

    /**
     * Set the authentication timeout for the socket.
     */
    protected setUserAuthenticationTimeout(ws: WebSocket): void {
        ws.userAuthenticationTimeout = setTimeout(() => {
            ws.sendJson({
                event: 'pusher:error',
                data: {
                    code: 4009,
                    message: 'Connection not authorized within timeout.',
                },
            });

            try {
                ws.end(4009);
            } catch (e) {
                //
            }
        }, this.server.options.userAuthenticationTimeout);
    }
}

/**
 * Checks if the input is an ArrayBuffer
 *
 * @param obj - The object to check
 * @returns boolean indicating if the object is an ArrayBuffer
 */
export function isArrayBuffer(obj: any): obj is ArrayBuffer {
    return obj instanceof ArrayBuffer ||
        (obj != null &&
            obj.constructor != null &&
            obj.constructor.name === 'ArrayBuffer' &&
            obj.byteLength != null);
}

/**
 * Converts an ArrayBuffer to a string with proper encoding handling.
 *
 * @param buffer - The ArrayBuffer to convert
 * @param encoding - The encoding to use (defaults to 'utf-8')
 * @returns The converted string
 * @throws Error if the conversion fails
 */
export function ab2str(buffer: ArrayBuffer, encoding = 'utf-8'): string {
    try {
        // First try using TextDecoder if available (modern browsers)
        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder(encoding).decode(buffer);
        }

        // Fallback for older environments
        // Convert ArrayBuffer to Uint8Array
        const uint8Array = new Uint8Array(buffer);

        // Convert Uint8Array to regular array
        const numbers = Array.prototype.slice.call(uint8Array);

        // Convert numbers to characters and join
        const result = String.fromCharCode.apply(null, numbers);

        // Handle UTF-8 encoding if needed
        if (encoding.toLowerCase() === 'utf-8') {
            // Handle UTF-8 encoding by decoding escaped sequences
            return decodeURIComponent(escape(result));
        }

        return result;
    } catch (error) {
        throw new Error(`Failed to convert ArrayBuffer to string: ${error.message}`);
    }
}
