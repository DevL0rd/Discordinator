import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { EventsService } from '../events/service.js';
import type { Principal } from '../events/security.js';
import { csv, type Config } from '../core/config.js';
import type { Bridge } from '../core/bridge.js';
import { Authenticator } from './auth.js';
import { createMcp } from './tools.js';

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers['content-length'] ?? 0) > 512_000) throw new Error('Body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 512_000) throw new Error('Body too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class HttpServer {
  readonly server;
  private active = 0;
  private requests = new Set<Promise<void>>();
  private requestTimes: number[] = [];
  private readonly auth: Authenticator;
  constructor(readonly config: Config, readonly bridge: Bridge, readonly status: () => unknown, readonly events?: EventsService) {
    this.auth = new Authenticator(config);
    this.server = createServer((request, response) => {
      const pending = this.handle(request, response).catch(() => {
        if (!response.headersSent) json(response, 400, { error: 'Invalid MCP request' });
        else response.end();
      }).finally(() => { this.requests.delete(pending); });
      this.requests.add(pending);
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 5000;
    this.server.maxConnections = 32;
  }

  private validHeaders(request: IncomingMessage): boolean {
    const host = request.headers.host;
    const defaults = [`127.0.0.1:${this.config.DOTBOT_PORT}`, `localhost:${this.config.DOTBOT_PORT}`];
    if (!host || ![...defaults, ...csv(this.config.DOTBOT_ALLOWED_HOSTS)].includes(host)) return false;
    const origin = request.headers.origin;
    return !origin || csv(this.config.DOTBOT_ALLOWED_ORIGINS).includes(origin);
  }

  private limited(): boolean {
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter(time => time > now - 60_000);
    if (this.active >= 16 || this.requestTimes.length >= 120) return true;
    this.requestTimes.push(now);
    return false;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.validHeaders(request)) return json(response, 403, { error: 'Host or Origin denied' });
    if (this.limited()) return json(response, 429, { error: 'Local request budget exhausted' });
    if (this.isMetadata(request)) return json(response, 200, this.auth.metadata());
    if (request.url !== '/mcp') return json(response, 404, { error: 'Unknown endpoint' });
    const principal = await this.auth.authenticate(request);
    if (!principal) {
      response.setHeader('WWW-Authenticate', this.auth.challenge());
      return json(response, 401, { error: 'Authentication required' });
    }
    if (request.method !== 'POST') return json(response, 405, { error: 'Stateless MCP supports POST only' });
    if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: 'JSON required' });
    await this.dispatch(request, response, principal);
  }

  private isMetadata(request: IncomingMessage): boolean {
    return this.config.DOTBOT_AUTH_MODE === 'oauth' && request.method === 'GET' &&
      ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(request.url ?? '');
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse, principal: Principal): Promise<void> {
    this.active++;
    const handler = createMcpHandler(ctx => createMcp(this.bridge, this.status,
      ctx.era === 'modern' ? { service: this.events, principal } : undefined),
      { maxRequestBodySize: 512_000 });
    try {
      const parsed = await body(request);
      if (Array.isArray(parsed)) throw new Error('Batch requests are not supported');
      await toNodeHandler(handler, { maxRequestBodySize: 512_000 })(request, response, parsed);
    } finally { await handler.close(); this.active--; }
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.DOTBOT_PORT, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
  }

  async stop(): Promise<void> {
    this.bridge.queue.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled([...this.requests]);
  }
}
