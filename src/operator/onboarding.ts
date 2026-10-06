import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useVerify, verifyChecks, verifyLines, type Check } from './onboarding-verify.js';
import { inviteCopy, inviteLink, inviteReady, ownerFrom, ownerMatches } from './onboarding-invite.js';
import { openInBrowser } from './web-connectors.js';
import { passwordError } from '../oauth/provision.js';
import { useApp, useInput, useStdout } from 'ink';
import { installService } from './install.js';
import { connectApp } from './connections.js';
import {
    discoverDiscord,
    savePassword,
    onboardingPhase,
    saveAi,
    saveDiscord,
    validateAi,
    verifyDiscord,
    writePhase,
} from './onboarding-store.js';
import type { AiChoice, DiscordDiscovery, DiscordDraft, DiscordIdentity } from './onboarding-store.js';
import { wizardFrame, type StepView } from './onboarding-view.js';
import { hits, targetAt, type Hit } from './ui/canvas.js';
import { h, Frame } from './ui/render.js';
import { assistants } from './ui/status.js';
import { useSgrMouse } from './ui/use-mouse.js';
import { typed, type Key } from './ui/keys.js';

type Setter = React.Dispatch<React.SetStateAction<State>>;
type Step =
    | 'loading'
    | 'welcome'
    | 'token'
    | 'invite'
    | 'owner'
    | 'channel'
    | 'discord-review'
    | 'ai'
    | 'endpoint'
    | 'password'
    | 'password-confirm'
    | 'ai-review'
    | 'plugin'
    | 'service'
    | 'verify';
interface State {
    step: Step;
    input: string;
    selected: number;
    draft: DiscordDraft;
    identity?: DiscordIdentity;
    discovery?: DiscordDiscovery;
    choice?: AiChoice;
    endpoint?: string;
    password?: string;
    checks?: Check[];
    evidence?: string;
    busy?: string;
    error?: string;
    notice?: string;
}
const choices: AiChoice[] = ['claude-session', 'codex-local', 'chatgpt-events', 'manual-mcp'];
const local = (choice?: AiChoice) => choice === 'codex-local' || choice === 'claude-session';
const stageOf: Record<Step, number> = {
    loading: 0,
    welcome: 0,
    token: 0,
    invite: 0,
    owner: 0,
    channel: 0,
    'discord-review': 0,
    ai: 1,
    endpoint: 1,
    password: 0,
    'password-confirm': 0,
    'ai-review': 1,
    plugin: 2,
    service: 3,
    verify: 3,
};
const textSteps: Step[] = ['token', 'owner', 'channel', 'endpoint', 'password', 'password-confirm'];
const maskedSteps: Step[] = ['token', 'password', 'password-confirm'];

function buttonsFor(state: State): string[] {
    const sets: Partial<Record<Step, string[]>> = {
        welcome: ['Begin'],
        invite: inviteReady(state.discovery) ? ['Continue'] : ['Open invite', 'Check again'],
        'discord-review': state.identity ? ['Save', 'Back'] : ['Verify'],
        'ai-review': ['Save', 'Back'],
        plugin: state.error ? ['Retry', 'Skip'] : ['Continue'],
        service: ['Skip', 'Install service', 'Back'],
        verify: state.checks?.every((check) => check.ok) ? ['Finish'] : ['Check again'],
    };
    return sets[state.step] ?? [];
}

function optionsFor(state: State): string[] | undefined {
    if (state.step === 'ai') return choices.map((choice) => assistants[choice].name);
    if (state.step === 'owner' && state.discovery?.members.length)
        return ownerMatches(state.discovery, state.input).map((member) => member.name);
    if (state.step === 'channel' && !state.input)
        return state.discovery?.channels.slice(0, 12).map((channel) => `${channel.guild} / #${channel.name}`);
}

function endpointCopy(choice?: AiChoice): { title: string; body: string[] } {
    if (!choice?.startsWith('chatgpt-'))
        return { title: 'MCP endpoint URL', body: ['The full URL your app uses, including https:// and the path.'] };
    return {
        title: 'Your public domain',
        body: [
            'Just the domain ChatGPT reaches Discordinator on, like bot.example.com. No https:// and no path.',
            `Point it (Cloudflare Tunnel or a reverse proxy) at http://127.0.0.1:${process.env.DISCORDINATOR_PORT ?? '8787'}, the port Discordinator listens on.`,
        ],
    };
}

const passwordCopy = {
    password: {
        title: 'Choose a sign-in password',
        body: [
            'Apps that reach Discordinator through a public domain, like ChatGPT and Claude on the web, sign in with this password. There is no username.',
            'At least 12 characters. You can change it later on the Apps page.',
        ],
    },
    confirm: { title: 'Confirm the password', body: ['Type the same password once more.'] },
};

function copy(state: State): { title: string; body: string[] } {
    const copies: Record<Step, () => { title: string; body: string[] }> = {
        loading: () => ({ title: 'Welcome', body: ['Reading your setup progress…'] }),
        welcome: () => ({
            title: 'Welcome to Discordinator',
            body: [
                'Discordinator lets an AI answer your Discord. First we connect your bot, then pick who answers.',
                'Nothing is written until you review it.',
            ],
        }),
        token: () => ({
            title: 'Your bot token',
            body: ['Paste the token from the Discord Developer Portal (Bot → Reset Token). It stays hidden.'],
        }),
        owner: () => ({
            title: 'Who is the owner?',
            body: ['Pick yourself from your server’s members. Type to search, or paste your Discord user ID.'],
        }),
        channel: () => ({ title: 'First channel', body: ['Pick where Discordinator starts answering, or type a channel ID.'] }),
        'discord-review': () => ({
            title: 'Check Discord',
            body: [
                `Bot: ${state.identity?.bot ?? state.discovery?.bot ?? 'not checked yet'}`,
                `Owner: ${state.identity?.owner ?? state.draft.ownerId}`,
                `Channel: ${state.identity?.channel ?? state.draft.channelId}`,
            ],
        }),
        ai: () => ({ title: 'Who answers Discord?', body: [assistants[choices[state.selected] ?? 'claude-session'].blurb] }),
        endpoint: () => endpointCopy(state.choice),
        invite: () => inviteCopy(state.discovery),
        password: () => passwordCopy.password,
        'password-confirm': () => passwordCopy.confirm,
        verify: () => ({ title: 'Make sure it works', body: verifyLines(state.checks) }),
        'ai-review': () => ({
            title: 'Ready to save',
            body: [`${assistants[state.choice!].name}`, state.evidence ?? '', 'It is saved paused. You start it from the dashboard.'],
        }),
        plugin: () => ({
            title: 'Connect Claude',
            body: ['Discordinator installs its Claude Code plugin so your Claude session can hear Discord.'],
        }),
        service: () => ({
            title: 'Keep Discordinator running',
            body: [
                'Optionally install Discordinator as a background service that starts when you log in.',
                'A Discordinator you started by hand is never stopped.',
            ],
        }),
    };
    return copies[state.step]();
}

function stepView(state: State, tick: number): StepView {
    const options = optionsFor(state);
    const view: StepView = { stage: stageOf[state.step], ...copy(state), selected: state.selected, tick, buttons: buttonsFor(state) };
    if (options) view.options = options;
    if (textSteps.includes(state.step)) view.input = { value: state.input, masked: maskedSteps.includes(state.step) };
    for (const key of ['notice', 'error', 'busy'] as const) if (state[key]) view[key] = state[key];
    return view;
}

function back(state: State): State {
    const previous: Partial<Record<Step, Step>> = {
        token: 'welcome',
        invite: 'token',
        owner: 'invite',
        channel: 'owner',
        'discord-review': 'channel',
        endpoint: 'ai',
        'password-confirm': 'password',
        'ai-review': local(state.choice) ? 'ai' : 'endpoint',
        service: 'ai-review',
        verify: 'service',
    };
    return { ...state, step: previous[state.step] ?? state.step, input: '', selected: 0, error: undefined, notice: undefined };
}

const fresh = (state: State): State => ({ ...state, input: '', selected: 0, error: undefined, notice: undefined });
type Advance = (state: State, button: string | undefined, onComplete: () => void) => State | Promise<State>;

async function discordReview(state: State, button: string | undefined): Promise<State> {
    if (!state.identity)
        return { ...state, identity: await verifyDiscord(state.draft), selected: 0, notice: 'Everything checks out. Save to continue.' };
    if (button === 'Back') return back(state);
    await saveDiscord(state.draft, state.identity);
    return { ...fresh(state), step: 'password', notice: 'Discord saved.' };
}

async function aiReview(state: State, button: string | undefined): Promise<State> {
    if (button === 'Back') return back(state);
    await saveAi(state.choice!, state.endpoint);
    return { ...fresh(state), step: state.choice === 'claude-session' ? 'plugin' : 'service' };
}

function channel(state: State): State {
    const channelId = state.input.trim() || state.discovery?.channels[state.selected]?.id;
    if (!channelId) throw new Error('Pick a channel or type its ID.');
    return { ...fresh(state), step: 'discord-review', draft: { ...state.draft, channelId } };
}

const steps: Partial<Record<Step, Advance>> = {
    welcome: (state) => ({ ...fresh(state), step: 'token' }),
    token: async (state) => ({
        ...fresh(state),
        step: 'invite',
        draft: { ...state.draft, token: state.input.trim() },
        discovery: await discoverDiscord(state.input.trim()),
    }),
    invite: async (state, button) => {
        if (inviteReady(state.discovery)) return { ...fresh(state), step: 'owner' };
        if (button === 'Open invite' && state.discovery) {
            await openInBrowser(inviteLink(state.discovery.botId));
            return { ...state, notice: 'Opened the invite in your browser. Add the bot, then choose Check again.' };
        }
        const discovery = await discoverDiscord(state.draft.token);
        return {
            ...state,
            discovery,
            error: inviteReady(discovery) ? undefined : 'Not done yet. Finish the unchecked items above, then check again.',
        };
    },
    owner: (state) => ({
        ...fresh(state),
        step: 'channel',
        draft: { ...state.draft, ownerId: ownerFrom(state.discovery, state.input, state.selected) },
    }),
    channel,
    'discord-review': discordReview,
    ai: (state) => {
        const choice = choices[state.selected]!;
        return local(choice) ? review({ ...fresh(state), choice }) : { ...fresh(state), step: 'endpoint', choice };
    },
    endpoint: (state) => review({ ...fresh(state), choice: state.choice! }, state.input.trim()),
    password: (state) => {
        const error = passwordError(state.input);
        if (error) throw new Error(error);
        return { ...fresh(state), step: 'password-confirm', password: state.input };
    },
    'password-confirm': async (state) => {
        if (state.input !== state.password) throw new Error('The passwords do not match. Type it again.');
        await savePassword(state.input);
        return { ...fresh(state), step: 'ai', password: undefined, notice: 'Password saved.' };
    },
    'ai-review': aiReview,
    plugin: (state, button) => (button === 'Skip' || !state.error ? { ...fresh(state), step: 'service' } : state),
    service: (state, button) => finish(state, button),
    verify: (state, _button, onComplete) => verify(state, onComplete),
};

function advance(state: State, onComplete: () => void): Promise<State> {
    const handler = steps[state.step];
    return Promise.resolve(handler ? handler(state, buttonsFor(state)[state.selected], onComplete) : state);
}

async function review(state: State, endpoint = ''): Promise<State> {
    return { ...state, step: 'ai-review', endpoint, evidence: await validateAi(state.choice!, endpoint) };
}

async function finish(state: State, button: string | undefined): Promise<State> {
    if (button === 'Back') return back(state);
    if (button === 'Install service') await installService();
    await writePhase('verify');
    return { ...fresh(state), step: 'verify', checks: await verifyChecks(state.choice) };
}

async function verify(state: State, onComplete: () => void): Promise<State> {
    const checks = await verifyChecks(state.choice);
    if (!checks.every((check) => check.ok))
        return { ...state, checks, error: 'Not everything is connected yet. Follow the next step shown above.' };
    await writePhase('complete');
    onComplete();
    return { ...state, checks };
}

function count(state: State): number {
    return optionsFor(state)?.length ?? buttonsFor(state).length;
}

const initial: State = { step: 'loading', input: '', selected: 0, draft: { token: '', ownerId: '', channelId: '' }, busy: 'Loading…' };
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

function usePhase(setState: Setter): void {
    useEffect(() => {
        void onboardingPhase(process.env).then((phase) => {
            const steps: Partial<Record<string, Step>> = { ai: 'ai', service: 'service', verify: 'verify' };
            const step: Step = steps[phase] ?? 'welcome';
            setState((current) => ({ ...current, busy: undefined, step }));
        });
    }, [setState]);
}

function usePluginInstall(state: State, setState: Setter): void {
    const pending = state.step === 'plugin' && !state.busy && !state.error && !state.notice;
    useEffect(() => {
        if (!pending) return;
        setState((current) => ({ ...current, busy: 'Connecting Claude Code…' }));
        void connectApp('claude-code')
            .then((notice) => setState((current) => ({ ...current, busy: undefined, notice })))
            .catch((error: unknown) => setState((current) => ({ ...current, busy: undefined, error: message(error, 'Install failed.') })));
    }, [pending, setState]);
}

function useTick(active: boolean): number {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => setTick((value) => value + 1), 140);
        return () => clearInterval(timer);
    }, [active]);
    return tick;
}

function move(state: State, key: Key): State | undefined {
    const total = count(state);
    const delta = Number(key.downArrow || key.rightArrow) - Number(key.upArrow || key.leftArrow);
    return delta && total ? { ...state, selected: (state.selected + delta + total) % total } : undefined;
}

function wizardKey(
    state: State,
    input: string,
    key: Key,
    actions: { exit(): void; submit(next: State): void; set(next: State): void },
): void {
    if (key.ctrl && input === 'c') return actions.exit();
    if (state.busy || input.includes('[<')) return;
    if (key.escape) return actions.set(back(state));
    const moved = move(state, key);
    if (moved) return actions.set(moved);
    if (key.return) return actions.submit(state);
    if (textSteps.includes(state.step)) actions.set({ ...state, input: typed(state.input, input, key), error: undefined });
}

export function Onboarding({ onComplete }: { onComplete: () => void }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [state, setState] = useState<State>(initial);
    const tick = useTick(Boolean(state.busy));
    const map = useRef<Hit[]>([]);
    const submit = (current: State) => {
        setState({ ...current, busy: 'Working…', error: undefined });
        void advance(current, onComplete)
            .then((next) => setState({ ...next, busy: undefined }))
            .catch((error: unknown) =>
                setState({ ...current, busy: undefined, error: message(error, 'Setup failed. Nothing was saved.') }),
            );
    };
    usePhase(setState);
    usePluginInstall(state, setState);
    const setChecks = useCallback((checks: Check[]) => setState((current) => ({ ...current, checks })), []);
    useVerify(state.step === 'verify', state.choice, setChecks);
    useSgrMouse((code, x, y) => {
        const target = code === 0 && !state.busy ? targetAt(map.current, x, y) : undefined;
        if (target) submit({ ...state, selected: Number(target.split(':')[1]) });
    });
    useInput((input, key) => wizardKey(state, input, key, { exit, submit, set: setState }));
    const lines = wizardFrame(stepView(state, tick), stdout.columns || 80, (stdout.rows || 24) - 1);
    map.current = hits(lines);
    return h(Frame, { lines });
}
