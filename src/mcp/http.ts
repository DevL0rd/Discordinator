import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JWTVerifyGetKey } from 'jose';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { EventsService } from '../events/service.js';
import type { Principal } from '../events/security.js';
import { csv, type Config } from '../core/config.js';
import type { Bridge } from '../core/bridge.js';
import { Authenticator } from './auth.js';
import { createMcp } from './tools.js';
import type { BundledOAuth } from '../oauth/server.js';
import { httpsOrigin } from '../core/canonical.js';
import { diagnose } from './diagnostics.js';
import { descriptorResponse } from './descriptors.js';

function json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
}

export class HttpServer {
    readonly server;
    onRemote?: () => void;
    private active = 0;
    private requests = new Set<Promise<void>>();
    private requestTimes: number[] = [];
    private readonly auth: Authenticator;
    constructor(
        readonly config: Config,
        readonly bridge: Bridge,
        readonly status: () => unknown,
        readonly events?: EventsService,
        verifyKey?: JWTVerifyGetKey,
        readonly oauth?: BundledOAuth,
    ) {
        this.auth = new Authenticator(config, verifyKey ?? oauth?.verifyKey);
        this.server = createServer((request, response) => {
            const pending = this.handle(request, response)
                .catch((error: unknown) => {
                    console.error(
                        `HTTP request failed ${JSON.stringify({
                            path: new URL(request.url ?? '/', 'http://localhost').pathname,
                            method: request.method,
                            error: error instanceof Error ? error.name : typeof error,
                            code: errorCode(error),
                        })}`,
                    );
                    if (!response.headersSent) json(response, 400, { error: 'Invalid MCP request' });
                    else response.end();
                })
                .finally(() => {
                    this.requests.delete(pending);
                });
            this.requests.add(pending);
        });
        this.server.requestTimeout = 30_000;
        this.server.headersTimeout = 5000;
        this.server.maxConnections = 32;
    }

    attachLocal(key: string): void {
        this.auth.localKey = key;
    }

    private validHeaders(request: IncomingMessage): boolean {
        const host = request.headers.host;
        const defaults = [`127.0.0.1:${this.config.DISCORDINATOR_PORT}`, `localhost:${this.config.DISCORDINATOR_PORT}`];
        const publicHosts = csv(this.config.DISCORDINATOR_ALLOWED_HOSTS)
            .map((value) => httpsOrigin(`https://${value}`))
            .filter((value) => value !== undefined);
        const publicHost = host ? httpsOrigin(`https://${host}`) : undefined;
        if (!host || (!defaults.includes(host) && (!publicHost || !publicHosts.includes(publicHost)))) return false;
        const origin = request.headers.origin;
        const ownerOrigin = this.oauth ? new URL(this.config.DISCORDINATOR_OAUTH_ISSUER!).origin : undefined;
        const allowedOrigins = [ownerOrigin, ...csv(this.config.DISCORDINATOR_ALLOWED_ORIGINS)]
            .filter((value) => value !== undefined)
            .map((value) => httpsOrigin(value));
        return !origin || allowedOrigins.includes(httpsOrigin(origin));
    }

    private limited(): boolean {
        const now = Date.now();
        this.requestTimes = this.requestTimes.filter((time) => time > now - 60_000);
        if (this.active >= 16 || this.requestTimes.length >= 120) return true;
        this.requestTimes.push(now);
        return false;
    }

    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        if (!this.validHeaders(request)) {
            console.error(
                `HTTP trust denied ${JSON.stringify({
                    path: new URL(request.url ?? '/', 'http://localhost').pathname,
                    method: request.method,
                    remote: request.socket.remoteAddress,
                    host: request.headers.host,
                    origin: request.headers.origin,
                    forwardedProto: request.headers['x-forwarded-proto'],
                })}`,
            );
            return json(response, 403, { error: 'Host or Origin denied' });
        }
        if (await this.preRoute(request, response)) return;
        logResponse(request, response);
        const principal = await this.auth.authenticate(request);
        if (!principal) {
            response.setHeader('WWW-Authenticate', this.auth.challenge());
            return json(response, 401, { error: 'Authentication required' });
        }
        if (!principal.id.startsWith('local:')) this.onRemote?.();
        await this.bridge.withOwner(() => this.authenticated(request, response, principal));
    }

    private async preRoute(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
        if (this.limited()) json(response, 429, { error: 'Local request budget exhausted' });
        else if (await this.oauth?.handle(request, response)) return true;
        else if (this.isMetadata(request)) json(response, 200, this.auth.metadata());
        else if (request.url !== '/mcp') json(response, 404, { error: 'Unknown endpoint' });
        else return false;
        return true;
    }

    private async authenticated(request: IncomingMessage, response: ServerResponse, principal: Principal): Promise<void> {
        if (request.method !== 'POST') return json(response, 405, { error: 'Stateless MCP supports POST only' });
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: 'JSON required' });
        await this.dispatch(request, response, principal);
    }

    private isMetadata(request: IncomingMessage): boolean {
        return (
            this.config.DISCORDINATOR_AUTH_MODE === 'oauth' &&
            request.method === 'GET' &&
            ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(request.url ?? '')
        );
    }

    private async dispatch(request: IncomingMessage, response: ServerResponse, principal: Principal): Promise<void> {
        this.active++;
        const handler = createMcpHandler(
            (ctx) =>
                createMcp(
                    this.bridge,
                    this.status,
                    ctx.era === 'modern' ? { service: this.events, principal } : undefined,
                    this.config.DISCORDINATOR_AUTH_MODE === 'oauth',
                ),
            { maxRequestBodySize: 512_000 },
        );
        try {
            await toNodeHandler(
                {
                    fetch: (request, options) =>
                        diagnose(request, (value) =>
                            descriptorResponse(
                                value,
                                (input) => handler.fetch(input, options),
                                this.config.DISCORDINATOR_AUTH_MODE === 'oauth',
                            ),
                        ),
                },
                {
                    maxRequestBodySize: 512_000,
                    onerror: (error) => console.error(`MCP adapter failed ${JSON.stringify({ error: error.name })}`),
                },
            )(request, response);
        } finally {
            await handler.close();
            this.active--;
        }
    }

    async start(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.config.DISCORDINATOR_PORT, '127.0.0.1', () => {
                this.server.off('error', reject);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        this.bridge.queue.close();
        this.server.closeAllConnections();
        await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
        await Promise.allSettled([...this.requests]);
        await this.oauth?.close();
    }
}

function errorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
    return typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : undefined;
}

function logResponse(request: IncomingMessage, response: ServerResponse): void {
    const started = Date.now();
    response.once('finish', () => {
        console.error(
            `MCP response ${JSON.stringify({
                method: request.method,
                status: response.statusCode,
                contentType: response.getHeader('content-type'),
                protocolVersion: request.headers['mcp-protocol-version'],
                durationMs: Date.now() - started,
            })}`,
        );
    });
}
