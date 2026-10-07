import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { replaceFile } from '../core/replace-file.js';
import { planReconnect } from './reconnect.js';
import { ownerReady } from '../oauth/provision.js';
import { dirname } from 'node:path';
import { parseEnv } from 'node:util';
import { policySchema, envSchema, validateAuth, type PolicyConfig } from '../core/config.js';
import { Policy } from '../core/policy.js';
import { DiscordApi } from '../discord/api.js';
import { operatorPath, operatorSchema, readOperatorConfig, writeOperatorConfig } from './config.js';
import { appState, connectApp, responderApps } from './connections.js';
import { publicDomainBlock } from './connection-domain.js';
import { validateModel } from './providers.js';
import { activationBlock, isLocal, liveSetupStatus, waitForLiveStatus } from './setup-model.js';
import { assignSetting, previewChanges, settings, settingValue, type SettingsSource } from './settings-registry.js';
import { managedServiceStatus } from './service-status.js';
import { scalar } from '../core/text.js';
import { assistantName, responderMode } from './ui/status.js';

export type Documents = Record<SettingsSource, Record<string, unknown>>;
export interface PanelSnapshot {
    documents: Documents;
    originals: Record<SettingsSource, string>;
    paths: Record<SettingsSource, string>;
}
const read = async (path: string) =>
    readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
    });
export async function readPanel(): Promise<PanelSnapshot> {
    const paths = {
        operator: '.data/operator-settings.json',
        policy: process.env.DISCORDINATOR_POLICY_FILE ?? 'policy.json',
        environment: '.env',
    };
    const originals = {
        operator: await read(paths.operator),
        policy: await read(paths.policy),
        environment: await read(paths.environment),
    };
    const environment = { ...process.env, ...parseEnv(originals.environment) };
    const resolved = Object.fromEntries(
        Object.entries(envSchema.shape).map(([key, schema]) => {
            const parsed = schema.safeParse(environment[key]);
            return [key, parsed.success ? parsed.data : environment[key]];
        }),
    );
    const operator = await readOperatorConfig(originals.operator ? paths.operator : operatorPath);
    return {
        paths,
        originals,
        documents: {
            operator: { ...operator, mode: responderMode(operator.mode) },
            policy: { ...policySchema.parse(originals.policy ? JSON.parse(originals.policy) : {}) },
            environment: resolved,
        },
    };
}
export function rebaseDrafts(before: PanelSnapshot, drafts: Documents, next: PanelSnapshot): Documents {
    const rebased = structuredClone(next.documents);
    for (const definition of settings) {
        const value = settingValue(drafts[definition.source], definition);
        if (JSON.stringify(value) === JSON.stringify(settingValue(before.documents[definition.source], definition))) continue;
        rebased[definition.source] = assignSetting(rebased[definition.source], definition, value);
    }
    return rebased;
}
export function draftChanges(snapshot: PanelSnapshot, drafts: Documents) {
    return (Object.keys(drafts) as SettingsSource[]).flatMap((source) =>
        previewChanges(source, snapshot.documents[source], drafts[source]),
    );
}
function changedSources(snapshot: PanelSnapshot, drafts: Documents): SettingsSource[] {
    return (Object.keys(drafts) as SettingsSource[]).filter(
        (source) => previewChanges(source, snapshot.documents[source], drafts[source]).length > 0,
    );
}
function envText(original: string, before: Record<string, unknown>, after: Record<string, unknown>): string {
    let text = original;
    for (const [key, value] of Object.entries(after)) {
        if (JSON.stringify(value) === JSON.stringify(before[key])) continue;
        if (!/^[A-Z][A-Z0-9_]+$/.test(key)) throw new Error('Invalid environment key');
        const encoded = JSON.stringify(scalar(value));
        const pattern = new RegExp(`^${key}=.*$`, 'm');
        text = pattern.test(text) ? text.replace(pattern, `${key}=${encoded}`) : `${text.trimEnd()}\n${key}=${encoded}\n`;
    }
    return text;
}
function assertOwnerApproved(policy: Record<string, unknown>): void {
    const owner = policy.ownerUserId;
    if (owner && !((policy.allowedUserIds as unknown[] | undefined) ?? []).includes(owner))
        throw new Error('The owner must be one of the approved people.');
}
function assertNamesReadable(snapshot: PanelSnapshot, policy: PolicyConfig, messageContent: string): void {
    const before = policySchema.safeParse(snapshot.documents.policy).data?.triggers.matchNames === true;
    if (!before && policy.triggers.matchNames && messageContent !== 'true')
        throw new Error('Name triggers require Message Content intent.');
}
async function validateDraft(snapshot: PanelSnapshot, drafts: Documents, source: SettingsSource): Promise<void> {
    assertOwnerApproved(drafts.policy);
    const env = envSchema.parse(drafts.environment);
    validateAuth(env);
    const policy = policySchema.parse(drafts.policy);
    assertNamesReadable(snapshot, policy, env.DISCORDINATOR_MESSAGE_CONTENT);
    if (source === 'policy') await validatePeople(snapshot, policy, env.DISCORD_BOT_TOKEN);
    const blocked = source === 'policy' ? undefined : publicDomainBlock(String(drafts.operator.mode), drafts.environment);
    if (blocked) throw new Error(blocked);
    if (
        env.DISCORDINATOR_OAUTH_SERVER === 'bundled' &&
        env.DISCORDINATOR_AUTH_MODE === 'oauth' &&
        !(await ownerReady(env.DISCORDINATOR_OAUTH_DATA_DIR))
    )
        throw new Error('Set a sign-in password first (Apps → Sign-in password); apps on your public domain sign in with it.');
    if (source === 'operator') await validateOperator(drafts.operator);
}
async function validatePeople(snapshot: PanelSnapshot, policy: ReturnType<typeof policySchema.parse>, token: string): Promise<void> {
    const previous = snapshot.documents.policy.allowedUserIds as string[];
    const added = policy.allowedUserIds.filter((id) => !previous.includes(id));
    const api = new DiscordApi(token, new Policy(policy));
    for (const id of added) {
        const user = (await api.get(`/users/${id}`)) as { id?: string };
        if (user.id !== id) throw new Error('Added Discord person or bot could not be found.');
    }
}
async function validateOperator(document: Record<string, unknown>): Promise<void> {
    const config = operatorSchema.parse(document);
    if (!isLocal(config.mode)) return;
    if (!(await stat(config.workspace)).isDirectory()) throw new Error('Workspace must be an existing directory.');
    await validateModel(config);
}
export async function startSaved(snapshot: PanelSnapshot, enabled: boolean): Promise<string> {
    const selected = operatorSchema.parse(snapshot.documents.operator);
    const active = await readOperatorConfig();
    const live = await liveSetupStatus();
    const handoff = enabled ? externalStart(selected.mode, live) : undefined;
    if (handoff) return handoff;
    const work = persistentWorkBlock(live, active.updatedAt);
    if (work) throw new Error('An assistant is still working. Wait for it to finish before switching.');
    if (enabled) {
        const blocked = publicDomainBlock(selected.mode, snapshot.documents.environment);
        if (blocked) throw new Error(blocked);
        await validateOperator(snapshot.documents.operator);
        const blocker = activationBlock(selected, live, true);
        if (blocker) throw new Error(blocker);
    }
    const target = enabled ? selected : active;
    await writeOperatorConfig({ ...target, enabled, exclusiveLocal: enabled && isLocal(target.mode) });
    const next = await readOperatorConfig();
    return (await operatorApplied(next)) ? startedMessage(enabled, target.mode) : 'Request saved. Waiting for Discordinator to respond.';
}
function externalStart(mode: string, live: Awaited<ReturnType<typeof liveSetupStatus>>): string | undefined {
    if (mode === 'manual-mcp') return 'Connect and start your assistant in its MCP client. No assistant was started here.';
    if (mode === 'chatgpt-events' && !live?.events.subscriptions)
        throw new Error('Connect automatic wake-ups in ChatGPT first. No wake-up connection was found.');
}
function startedMessage(enabled: boolean, mode: ReturnType<typeof operatorSchema.parse>['mode']): string {
    if (!enabled) return 'Local assistant paused. Cloud automations are managed in their app.';
    return isLocal(mode) ? 'Assistant started.' : 'Discordinator wake-up connection selected. Replies are managed in ChatGPT.';
}
interface ControllerStatus {
    busy?: number;
    approvals?: number;
    queued?: number;
    pendingDelivery?: number;
    tasks?: { state?: string }[];
}
export function persistentWorkBlock(live: Awaited<ReturnType<typeof liveSetupStatus>>, expectedRevision: string): string | undefined {
    if (!live) return;
    const operator = live.operator as typeof live.operator & { controller?: ControllerStatus | null };
    const controller = operator.controller;
    if (controllerOwnsWork(controller))
        return 'Persistent controller work or recovery owns this conversation. Wait before changing responders.';
    if (controllerHasDelivery(controller)) return 'Persistent controller delivery is pending. Wait before changing responders.';
    if (operator.appliedConfigAt && operator.appliedConfigAt !== expectedRevision)
        return 'A previous operator configuration is still pending application. Refresh before activating a local provider.';
}
function controllerOwnsWork(controller?: ControllerStatus | null): boolean {
    const active = controller?.tasks?.some((task) => ['queued', 'running', 'approval', 'recovering'].includes(task.state ?? ''));
    return Boolean(controller && ((controller.busy ?? 0) > 0 || (controller.approvals ?? 0) > 0 || active));
}
function controllerHasDelivery(controller?: ControllerStatus | null): boolean {
    return Boolean(controller && ((controller.queued ?? 0) > 0 || (controller.pendingDelivery ?? 0) > 0));
}
function operatorApplied(next: Record<string, unknown>): Promise<boolean> {
    return waitForLiveStatus((status) => status.operator.appliedConfigAt === next.updatedAt, 2000);
}
type Activation = 'applied' | 'pending' | 'paused';
async function selectResponder(updated: PanelSnapshot): Promise<Activation> {
    const selected = operatorSchema.parse(updated.documents.operator);
    const active = await readOperatorConfig();
    const switching = selected.mode !== active.mode;
    const app = responderApps[selected.mode];
    if (switching && app && !(await appState(app)).connected) await connectApp(app);
    const enabled = switching || active.enabled;
    await writeOperatorConfig({ ...selected, enabled, exclusiveLocal: enabled && isLocal(selected.mode) });
    if (!enabled) return 'paused';
    return (await operatorApplied(await readOperatorConfig())) ? 'applied' : 'pending';
}
async function operatorMessage(activation: Activation, mode: string): Promise<string> {
    if (activation === 'paused') return `Saved. ${assistantName(mode)} stays paused until you start it.`;
    if (mode === 'chatgpt-events' && !(await liveSetupStatus())?.events.subscriptions)
        return `Saved, but ChatGPT has no wake-up connection, so nothing will answer yet. In ChatGPT, reconnect Discordinator and turn on automatic wake-ups.`;
    return activation === 'applied'
        ? `Saved. ${assistantName(mode)} is now the primary responder.`
        : `Saved. ${assistantName(mode)} takes over once Discordinator finishes any current work.`;
}
async function environmentMessage(): Promise<string> {
    return (await managedServiceStatus()).active
        ? 'Settings saved. Discordinator applies them right away, without restarting.'
        : 'Settings saved. Discordinator uses them as soon as it is running.';
}
function withEvents(snapshot: PanelSnapshot, drafts: Documents): Documents {
    const choosing = drafts.operator.mode === 'chatgpt-events' && snapshot.documents.operator.mode !== 'chatgpt-events';
    const events = settings.find((definition) => definition.id === 'policy.mcpEvents.enabled')!;
    if (!choosing || settingValue(drafts.policy, events) === true) return drafts;
    return { ...drafts, policy: assignSetting(drafts.policy, events, true) };
}
async function saveSource(snapshot: PanelSnapshot, drafts: Documents, source: SettingsSource): Promise<string> {
    const path = snapshot.paths[source];
    if ((await read(path)) !== snapshot.originals[source])
        throw new Error('Configuration changed elsewhere. Press R to reload; nothing has been saved.');
    const backup = `.data/setup-backups/${Date.now()}-${source}.json`;
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    await writeFile(backup, JSON.stringify({ path, original: snapshot.originals[source] }), { mode: 0o600, flush: true });
    const next = source === 'operator' ? { ...drafts.operator, updatedAt: new Date().toISOString() } : drafts[source];
    const text =
        source === 'environment'
            ? envText(snapshot.originals.environment, snapshot.documents.environment, next)
            : JSON.stringify(next, null, 2) + '\n';
    const temporary = `${path}.${process.pid}.setup.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, text, { mode: 0o600, flush: true });
    if ((await read(path)) !== snapshot.originals[source])
        throw new Error('Concurrent edit detected. Backup retained; no target overwritten.');
    await replaceFile(temporary, path);
    return text;
}
async function saveSources(snapshot: PanelSnapshot, drafts: Documents, sources: SettingsSource[]): Promise<void> {
    for (const source of sources) {
        await validateDraft(snapshot, drafts, source);
        if ((await read(snapshot.paths[source])) !== snapshot.originals[source])
            throw new Error('Configuration changed elsewhere. Press R to reload; nothing has been saved.');
    }
    const written = new Map<SettingsSource, string>();
    try {
        for (const source of sources) written.set(source, await saveSource(snapshot, drafts, source));
    } catch (error) {
        for (const [source, saved] of written) {
            if ((await read(snapshot.paths[source])) !== saved)
                throw new Error('Save interrupted by another editor. Private backups are available in .data/setup-backups.', {
                    cause: error,
                });
            const temporary = `${snapshot.paths[source]}.${process.pid}.rollback.tmp`;
            await writeFile(temporary, snapshot.originals[source], { mode: 0o600, flush: true });
            await replaceFile(temporary, snapshot.paths[source]);
        }
        throw error;
    }
}
async function attempt<T>(work: () => Promise<T>, failed: T, failures: string[]): Promise<T> {
    try {
        return await work();
    } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        return failed;
    }
}
export interface Applied {
    snapshot: PanelSnapshot;
    message: string;
    warning?: boolean;
}
export async function applyDraft(
    snapshot: PanelSnapshot,
    drafts: Documents,
    reconnect: typeof planReconnect = planReconnect,
): Promise<Applied> {
    const prepared = withEvents(snapshot, drafts);
    const sources = changedSources(snapshot, prepared);
    if (!sources.length) return { snapshot, message: 'No changes to save.' };
    const finish = await reconnect(draftChanges(snapshot, prepared), prepared.environment);
    await saveSources(snapshot, prepared, sources);
    const updated = await readPanel();
    const failures: string[] = [];
    const mode = String(updated.documents.operator.mode);
    const messages: string[] = [];
    if (sources.includes('environment')) messages.push(await environmentMessage());
    if (sources.includes('operator'))
        messages.push(await operatorMessage(await attempt(() => selectResponder(updated), 'paused', failures), mode));
    if (sources.includes('policy'))
        messages.push(prepared === drafts ? 'Discord settings saved and applied.' : 'Wake-up events are now allowed for ChatGPT.');
    const reconnected = await attempt(finish, '', failures);
    if (failures.length) return { snapshot: updated, message: `Saved, but ${failures.join(' ')}`, warning: true };
    return { snapshot: updated, message: `${messages.join(' ')}${reconnected}` };
}
