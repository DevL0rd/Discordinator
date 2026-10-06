import { loadConfig } from './core/config.js';
import { PresenceWriter } from './operator/presence.js';
import { CommandService } from './operator/commands.js';
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
import { BundledOAuth } from './oauth/server.js';
import { OperatorService } from './operator/service.js';
import { loadLocalKey } from './mcp/local-key.js';
import { restartOnChange, restartRequestFile } from './operator/environment-watcher.js';
import { migrateEnvironment } from './core/env-migration.js';
import { ReplyOrigins } from './core/reply-origins.js';
import { PolicyWatcher } from './operator/policy-watcher.js';

async function main(): Promise<void> {
    await migrateEnvironment();
    const { config, policy: policyConfig } = await loadConfig(process.env);
    const release = await acquireRuntime();
    let stage = 'oauth';
    try {
        const oauth =
            config.DISCORDINATOR_AUTH_MODE === 'oauth' && config.DISCORDINATOR_OAUTH_SERVER === 'bundled'
                ? await BundledOAuth.open(config)
                : undefined;
        try {
            stage = 'server';
            await run(config, policyConfig, release, oauth);
        } catch (error) {
            await oauth?.close();
            throw error;
        }
    } catch (error) {
        await release();
        failure('Discordinator initialization failed', stage, error);
        throw error;
    }
}

async function run(
    config: import('./core/config.js').Config,
    policyConfig: import('./core/config.js').PolicyConfig,
    release: () => Promise<void>,
    oauth?: BundledOAuth,
): Promise<void> {
    const runtime = await createRuntime(config, policyConfig, oauth);
    const { gateway, http, events, operator, people, presence } = runtime;
    const stop = shutdownOnce(runtime, release);
    registerSignals(stop);
    let stage = 'gateway';
    try {
        await gateway.start();
        stage = 'http';
        await http.start();
        stage = 'events';
        events.start();
        operator.start();
        people.start();
        await presence.start(events.status().subscriptions);
        restartOnChange(
            ['.env', restartRequestFile],
            () => operator.whenIdle(),
            async () => {
                await stop();
                process.exit(75);
            },
        );
        console.log(`Discordinator MCP listening on http://127.0.0.1:${config.DISCORDINATOR_PORT}/mcp`);
    } catch (error) {
        failure('Discordinator startup failed', stage, error);
        gateway.stop();
        if (http.server.listening) await http.stop();
        throw new Error('Startup failed; check credentials, intents, policy and port availability', { cause: error });
    }
}

async function createRuntime(
    config: import('./core/config.js').Config,
    policyConfig: import('./core/config.js').PolicyConfig,
    oauth?: BundledOAuth,
) {
    const policy = new Policy(policyConfig);
    const queue = new EventQueue();
    const journal = new Journal('.data/idempotency.json');
    await journal.load();
    const replyOrigins = new ReplyOrigins('.data/reply-origins.json');
    await replyOrigins.load();
    const replyJournal = new Journal('.data/reply-idempotency.json', 16384, Date.now, 7 * 24 * 60 * 60_000);
    await replyJournal.load();
    const approvals = new Approvals(policy);
    const api = new DiscordApi(config.DISCORD_BOT_TOKEN, policy);
    const bridge = new Bridge(policy, queue, journal, approvals, api, replyOrigins, replyJournal);
    const store = new SubscriptionStore('.data/subscriptions.json');
    await store.load();
    const events = new EventsService(
        store,
        policy,
        new Authenticator(config, oauth?.verifyKey).ownerAllowed,
        undefined,
        undefined,
        () => operator.status().mode === 'chatgpt-events',
    );
    const gateway = new Gateway(config, policy, queue, approvals, api, {
        context: bridge.context,
        events,
        media: bridge.media,
        flows: bridge.flows,
        replyOrigins,
        commands: (name, options) => commands.run(name, options),
    });
    const operator = new OperatorService(queue, bridge);
    const commands = new CommandService(operator);
    const people = new PolicyWatcher(config.DISCORDINATOR_POLICY_FILE, policy, replyOrigins);
    const http = new HttpServer(
        config,
        bridge,
        () => ({ ...gateway.status(), events: events.status(), operator: operator.status() }),
        events,
        undefined,
        oauth,
    );
    http.attachLocal(await loadLocalKey());
    const presence = new PresenceWriter();
    store.onChange = (state) => presence.update({ subscriptions: state.subscriptions.length });
    http.onRemote = () => presence.remoteSignedIn();
    return { gateway, http, events, operator, people, presence };
}
function shutdownOnce(runtime: Awaited<ReturnType<typeof createRuntime>>, release: () => Promise<void>): () => Promise<void> {
    let stopping: Promise<void> | undefined;
    return () => (stopping ??= shutdown(runtime.gateway, runtime.http, runtime.events, runtime.operator, release, runtime.people));
}
function registerSignals(stop: () => Promise<void>): void {
    process.once('SIGINT', () => {
        void stop().catch(() => {
            process.exitCode = 1;
        });
    });
    process.once('SIGTERM', () => {
        void stop().catch(() => {
            process.exitCode = 1;
        });
    });
}

function failure(label: string, stage: string, error: unknown): void {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    console.error(`${label} ${JSON.stringify({ stage, error: error instanceof Error ? error.name : typeof error, code })}`);
}

async function shutdown(
    gateway: Gateway,
    http: HttpServer,
    events: EventsService,
    operator: OperatorService,
    release: () => Promise<void>,
    people: PolicyWatcher,
): Promise<void> {
    gateway.stop();
    await people.stop();
    await Promise.all([events.stop(), http.stop(), operator.stop()]);
    // Ensure dispatched subscription mutations drained before releasing the directory lock.
    await events.stop();
    await release();
}

main().catch(() => {
    console.error('Discordinator could not start; check local configuration');
    process.exitCode = 1;
});
