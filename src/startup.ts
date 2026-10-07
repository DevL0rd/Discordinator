import { loadConfig, type Config, type PolicyConfig } from './core/config.js';
import { PresenceWriter } from './operator/presence.js';
import { StatusWriter } from './operator/status-file.js';
import { CommandService } from './operator/commands.js';
import { Policy } from './core/policy.js';
import { EventQueue } from './core/queue.js';
import { Journal } from './core/journal.js';
import { Approvals } from './core/approvals.js';
import { Bridge } from './core/bridge.js';
import { DiscordApi, type Api } from './discord/api.js';
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
import { VoiceService } from './voice/service.js';
import { TranscriptStore } from './voice/transcripts.js';
import { Gemini } from './voice/gemini.js';
import { interactionEventName, interactionPayload } from './events/schema.js';
import { baseEnvironment, reconfigure, watchEnvironment, type Reconfigurable } from './reconfigure.js';
import { readFile } from 'node:fs/promises';

export interface Host {
    env: NodeJS.ProcessEnv;
    exitCode?: typeof process.exitCode;
    on(event: 'unhandledRejection', listener: (error: unknown) => void): unknown;
    once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    exit(code: number): void;
}

export type GatewayPort = Pick<Gateway, 'start' | 'stop' | 'status' | 'onState'>;

export interface Startup {
    host: Host;
    api: (token: string, policy: Policy) => Api;
    gateway: (...args: ConstructorParameters<typeof Gateway>) => GatewayPort;
}

const defaults: Startup = {
    host: process,
    api: (token, policy) => new DiscordApi(token, policy),
    gateway: (...args) => new Gateway(...args),
};

export async function launch(options: Partial<Startup> = {}): Promise<void> {
    const startup = { ...defaults, ...options };
    await main(startup).catch(() => {
        console.error('Discordinator could not start; check local configuration');
        startup.host.exitCode = 1;
    });
}

async function main(startup: Startup): Promise<void> {
    await migrateEnvironment('.env', startup.host.env);
    const base = baseEnvironment(startup.host.env, await readFile('.env', 'utf8').catch(() => ''));
    const { config, policy: policyConfig } = await loadConfig(startup.host.env);
    const release = await acquireRuntime();
    let stage = 'oauth';
    try {
        const oauth =
            config.DISCORDINATOR_AUTH_MODE === 'oauth' && config.DISCORDINATOR_OAUTH_SERVER === 'bundled'
                ? await BundledOAuth.open(config)
                : undefined;
        try {
            stage = 'server';
            await run(startup, config, policyConfig, release, oauth, base);
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
    startup: Startup,
    config: Config,
    policyConfig: PolicyConfig,
    release: () => Promise<void>,
    oauth: BundledOAuth | undefined,
    base: NodeJS.ProcessEnv,
): Promise<void> {
    const runtime = await createRuntime(startup, config, policyConfig, oauth);
    const { events, operator, people, presence } = runtime;
    const stop = shutdownOnce(runtime, release);
    registerSignals(startup.host, stop);
    let stage = 'gateway';
    try {
        await runtime.gateway.start();
        stage = 'http';
        await runtime.http.start();
        stage = 'events';
        events.start();
        operator.start();
        people.start();
        await presence.start(events.status().subscriptions);
        runtime.watching.push(
            restartOnChange(
                [restartRequestFile],
                () => operator.whenIdle(),
                async () => {
                    await stop();
                    startup.host.exit(75);
                },
            ),
            watchEnvironment('.env', base, (next) => applySettings(runtime, config, next)),
        );
        console.log(`Discordinator MCP listening on http://127.0.0.1:${config.DISCORDINATOR_PORT}/mcp`);
    } catch (error) {
        failure('Discordinator startup failed', stage, error);
        await stop();
        throw new Error('Startup failed; check credentials, intents, policy and port availability', { cause: error });
    }
}

async function createCore(startup: Startup, config: Config, policyConfig: PolicyConfig) {
    const policy = new Policy(policyConfig);
    const queue = new EventQueue();
    const journal = new Journal('.data/idempotency.json');
    await journal.load();
    const replyOrigins = new ReplyOrigins('.data/reply-origins.json');
    await replyOrigins.load();
    const replyJournal = new Journal('.data/reply-idempotency.json', 16384, Date.now, 7 * 24 * 60 * 60_000);
    await replyJournal.load();
    const approvals = new Approvals(policy);
    const api = startup.api(config.DISCORD_BOT_TOKEN, policy);
    const bridge = new Bridge(policy, queue, journal, approvals, api, replyOrigins, replyJournal);
    const voice = (bridge.voice = createVoice(config, bridge));
    const store = new SubscriptionStore('.data/subscriptions.json');
    await store.load();
    return { policy, queue, approvals, api, bridge, voice, store, replyOrigins };
}

async function createRuntime(startup: Startup, config: Config, policyConfig: PolicyConfig, oauth?: BundledOAuth) {
    const core = await createCore(startup, config, policyConfig);
    const { policy, queue, approvals, api, bridge, voice, store, replyOrigins } = core;
    const access = { auth: new Authenticator(config, oauth?.verifyKey) };
    const events = new EventsService(
        store,
        policy,
        (id) => access.auth.ownerAllowed(id),
        undefined,
        undefined,
        () => operator.status().mode === 'chatgpt-events',
    );
    const services = {
        context: bridge.context,
        events,
        media: bridge.media,
        flows: bridge.flows,
        replyOrigins,
        people: bridge.people,
        voice,
        commands: (name: string, options: Record<string, string | undefined>, origin: Parameters<CommandService['run']>[2]) =>
            commands.run(name, options, origin),
    };
    voice.requests.publish = (event) => events.emit(interactionPayload(event, null), interactionEventName);
    const operator = new OperatorService(queue, bridge);
    const commands = new CommandService(operator);
    const people = new PolicyWatcher(config.DISCORDINATOR_POLICY_FILE, policy, replyOrigins);
    const presence = new PresenceWriter();
    const localKey = await loadLocalKey();
    const runtime = {
        gateway: startup.gateway(config, policy, queue, approvals, api, services),
        http: undefined as unknown as HttpServer,
        oauth,
        access,
        events,
        operator,
        people,
        presence,
        voice,
        watching: [] as (() => void)[],
        touch: () => undefined as void,
        status: () => ({ ...runtime.gateway.status(), events: events.status(), operator: operator.status(), voice: voice.status() }),
        listen: (): HttpServer => listener(config, bridge, runtime, localKey),
        connect: () => startup.gateway(config, policy, queue, approvals, api, services),
        api,
    };
    runtime.http = runtime.listen();
    const statusFile = new StatusWriter(() => ({ ...bridge.status(), ...runtime.status() }));
    runtime.touch = () => statusFile.touch();
    runtime.gateway.onState = runtime.touch;
    operator.onStatus = runtime.touch;
    voice.onChange = runtime.touch;
    store.onChange = (state) => {
        presence.update({ subscriptions: state.subscriptions.length });
        runtime.touch();
    };
    runtime.touch();
    return runtime;
}

type Runtime = Awaited<ReturnType<typeof createRuntime>>;

function listener(
    config: Config,
    bridge: Bridge,
    runtime: { status: () => unknown; events: EventsService; oauth?: BundledOAuth | undefined; presence: PresenceWriter },
    localKey: string,
): HttpServer {
    const http = new HttpServer(config, bridge, runtime.status, runtime.events, undefined, runtime.oauth);
    http.attachLocal(localKey);
    http.onRemote = () => runtime.presence.remoteSignedIn();
    return http;
}

/** Rebuilds only what a settings change affects, inside the running process. */
function liveTargets(runtime: Runtime, config: Config): Reconfigurable {
    return {
        movePolicy: (path) => runtime.people.move(path),
        restartListener: async () => {
            await runtime.http.stop();
            await runtime.oauth?.close();
            runtime.oauth =
                config.DISCORDINATOR_AUTH_MODE === 'oauth' && config.DISCORDINATOR_OAUTH_SERVER === 'bundled'
                    ? await BundledOAuth.open(config)
                    : undefined;
            runtime.access.auth = new Authenticator(config, runtime.oauth?.verifyKey);
            runtime.http = runtime.listen();
            await runtime.http.start();
            console.log(`Discordinator MCP listening on http://127.0.0.1:${config.DISCORDINATOR_PORT}/mcp`);
        },
        reconnectGateway: async () => {
            runtime.api.setToken?.(config.DISCORD_BOT_TOKEN);
            await runtime.voice.stop();
            const previous = runtime.gateway;
            previous.onState = undefined;
            previous.stop();
            runtime.gateway = runtime.connect();
            runtime.gateway.onState = runtime.touch;
            await runtime.gateway.start();
        },
    };
}

async function applySettings(runtime: Runtime, config: Config, next: Config): Promise<void> {
    try {
        const changed = await reconfigure(config, next, liveTargets(runtime, config));
        if (changed.length) console.error(`Applied new settings without restarting: ${changed.join(', ')}`);
    } catch (error) {
        failure('Settings change could not be applied; the previous settings were restored', 'reconfigure', error);
    }
    runtime.touch();
}

function createVoice(config: Config, bridge: Bridge): VoiceService {
    const gemini = new Gemini(() => config.GEMINI_API_KEY);
    return new VoiceService(bridge.policy, bridge.queue, bridge.api, bridge.people, new TranscriptStore(), gemini);
}
function shutdownOnce(runtime: Runtime, release: () => Promise<void>): () => Promise<void> {
    let stopping: Promise<void> | undefined;
    return () =>
        (stopping ??= Promise.resolve()
            .then(() => {
                for (const stop of runtime.watching) stop();
                return runtime.voice.stop();
            })
            .catch(() => undefined)
            .then(() => shutdown(runtime.gateway, runtime.http, runtime.events, runtime.operator, release, runtime.people)));
}
function registerSignals(host: Host, stop: () => Promise<void>): void {
    host.on('unhandledRejection', (error) => failure('Discordinator unhandled rejection', 'runtime', error));
    const stopOnSignal = () => {
        void stop().catch(() => {
            host.exitCode = 1;
        });
    };
    host.once('SIGINT', stopOnSignal);
    host.once('SIGTERM', stopOnSignal);
}

function failure(label: string, stage: string, error: unknown): void {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    console.error(`${label} ${JSON.stringify({ stage, error: error instanceof Error ? error.name : typeof error, code })}`);
}

async function shutdown(
    gateway: GatewayPort,
    http: HttpServer,
    events: EventsService,
    operator: OperatorService,
    release: () => Promise<void>,
    people: PolicyWatcher,
): Promise<void> {
    gateway.stop();
    await people.stop();
    await Promise.all([events.stop(), http.stop(), operator.stop()]);
    await events.stop();
    await release();
}
