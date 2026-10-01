import { loadConfig } from './core/config.js';
import { Policy } from './core/policy.js';
import { EventQueue } from './core/queue.js';
import { Journal } from './core/journal.js';
import { Approvals } from './core/approvals.js';
import { Bridge } from './core/bridge.js';
import { DiscordApi } from './discord/api.js';
import { Gateway } from './discord/gateway.js';
import { HttpServer } from './mcp/http.js';
import { EventsService } from './events/service.js';
import { SubscriptionStore } from './events/store.js';
import { Authenticator } from './mcp/auth.js';
import { acquireRuntime } from './core/runtime.js';

async function main(): Promise<void> {
  const { config, policy: policyConfig } = await loadConfig(process.env);
  const release = await acquireRuntime();
  try { await run(config, policyConfig, release); }
  catch (error) { await release(); throw error; }
}

async function run(config: import('./core/config.js').Config, policyConfig: import('./core/config.js').PolicyConfig, release: () => Promise<void>): Promise<void> {
  const policy = new Policy(policyConfig);
  const queue = new EventQueue();
  const journal = new Journal('.data/idempotency.json');
  await journal.load();
  const approvals = new Approvals(policy);
  const api = new DiscordApi(config.DISCORD_BOT_TOKEN, policy);
  const bridge = new Bridge(policy, queue, journal, approvals, api);
  const store = new SubscriptionStore('.data/subscriptions.json');
  await store.load();
  const events = new EventsService(store, policy, new Authenticator(config).ownerAllowed);
  const gateway = new Gateway(config, policy, queue, approvals, api, bridge.context, events, bridge.media, bridge.flows);
  const http = new HttpServer(config, bridge, () => ({ ...gateway.status(), events: events.status() }), events);
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= shutdown(gateway, http, events, release);
  process.once('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
  try {
    await gateway.start();
    await http.start();
    events.start();
    console.log(`DotBot MCP listening on http://127.0.0.1:${config.DOTBOT_PORT}/mcp`);
  } catch {
    gateway.stop();
    if (http.server.listening) await http.stop();
    throw new Error('Startup failed; check credentials, intents, policy and port availability');
  }
}

async function shutdown(gateway: Gateway, http: HttpServer, events: EventsService, release: () => Promise<void>): Promise<void> {
  gateway.stop();
  await Promise.all([events.stop(), http.stop()]);
  // Ensure dispatched subscription mutations drained before releasing the directory lock.
  await events.stop();
  await release();
}

main().catch(() => { console.error('DotBot could not start; check local configuration'); process.exitCode = 1; });
