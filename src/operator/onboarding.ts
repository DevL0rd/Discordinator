import React, { useCallback, useEffect, useRef, useState } from 'react';
import { savedPublicUrl, useVerify, verifyChecks, type Check } from './onboarding-verify.js';
import { inviteLink, inviteReady, ownerFrom } from './onboarding-invite.js';
import { markWebAdded } from './web-connectors.js';
import { openUrl } from './open-url.js';
import { passwordError } from '../oauth/provision.js';
import { useApp, useInput, useStdout } from 'ink';
import { installService } from './install.js';
import { appNames, connectApp, responderApps } from './connections.js';
import { readOperatorConfig, type OperatingMode } from './config.js';
import { domainError } from './connection-domain.js';
import { readPanel, startSaved } from './panel-store.js';
import {
    discoverDiscord,
    needsPassword,
    savePassword,
    onboardingPhase,
    saveAi,
    saveDiscord,
    validateAi,
    verifyDiscord,
    writePhase,
    type OnboardingPhase,
} from './onboarding-store.js';
import { buttonsFor, choices, count, startable, stepView, textSteps, type State, type Step } from './onboarding-copy.js';
import { wizardFrame } from './onboarding-view.js';
import { hits, targetAt, type Hit } from './ui/canvas.js';
import { h, Frame } from './ui/render.js';
import { responderMode } from './ui/status.js';
import { useSgrMouse } from './ui/use-mouse.js';
import { typed, type Key } from './ui/keys.js';

type Setter = React.Dispatch<React.SetStateAction<State>>;

function back(state: State): State {
    const domainOrAi: Step = state.choice === 'chatgpt-events' ? 'domain' : 'ai';
    const previous: Partial<Record<Step, Step>> = {
        token: 'welcome',
        invite: 'token',
        owner: 'invite',
        channel: 'owner',
        'discord-review': 'channel',
        domain: 'ai',
        password: domainOrAi,
        'password-confirm': 'password',
        'ai-review': domainOrAi,
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
    return { ...fresh(state), step: 'ai', notice: 'Discord saved.' };
}

async function aiReview(state: State, button: string | undefined): Promise<State> {
    if (button === 'Back') return back(state);
    await saveAi(state.choice!, state.domain);
    return { ...fresh(state), step: responderApps[state.choice!] ? 'connect' : 'service' };
}

function channel(state: State): State {
    const channelId = state.input.trim() || state.discovery?.channels[state.selected]?.id;
    if (!channelId) throw new Error('Pick a channel or type its ID.');
    return { ...fresh(state), step: 'discord-review', draft: { ...state.draft, channelId } };
}

async function review(state: State): Promise<State> {
    return { ...state, step: 'ai-review', evidence: await validateAi(state.choice!, state.domain) };
}

async function signIn(state: State): Promise<State> {
    return (await needsPassword(state.choice!)) ? { ...state, step: 'password' } : review(state);
}

function domain(state: State): Promise<State> {
    const value = state.input.trim();
    const error = domainError(value);
    if (error) throw new Error(error);
    return signIn({ ...fresh(state), domain: value });
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
            await openUrl(inviteLink(state.discovery.botId));
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
        return choice === 'chatgpt-events' ? { ...fresh(state), step: 'domain', choice } : signIn({ ...fresh(state), choice });
    },
    domain,
    password: (state) => {
        const error = passwordError(state.input);
        if (error) throw new Error(error);
        return { ...fresh(state), step: 'password-confirm', password: state.input };
    },
    'password-confirm': async (state) => {
        if (state.input !== state.password) throw new Error('The passwords do not match. Type it again.');
        await savePassword(state.input);
        return review({ ...fresh(state), password: undefined, notice: 'Password saved.' });
    },
    'ai-review': aiReview,
    connect: (state, button) => (button === 'Skip' || !state.error ? { ...fresh(state), step: 'service' } : fresh(state)),
    service: (state, button) => finish(state, button),
    verify: (state, _button, onComplete) => verify(state, onComplete),
};

export function resumed(phase: OnboardingPhase, mode: OperatingMode): Pick<State, 'step' | 'choice'> {
    const steps: Partial<Record<OnboardingPhase, Step>> = { ai: 'ai', service: 'service', verify: 'verify' };
    const step = steps[phase] ?? 'welcome';
    return step === 'service' || step === 'verify' ? { step, choice: responderMode(mode) } : { step };
}

export async function advance(state: State, onComplete: () => void): Promise<State> {
    const handler = steps[state.step];
    return handler ? handler(state, buttonsFor(state)[state.selected], onComplete) : state;
}

async function finish(state: State, button: string | undefined): Promise<State> {
    if (button === 'Back') return back(state);
    if (button === 'Install service') await installService();
    await writePhase('verify');
    return { ...fresh(state), step: 'verify', checks: await verifyChecks(state.choice) };
}

async function verify(state: State, onComplete: () => void): Promise<State> {
    let checks = await verifyChecks(state.choice);
    if (startable(checks) && checks.some((check) => !check.ok)) {
        await startSaved(await readPanel(), true);
        checks = await verifyChecks(state.choice);
    }
    if (!checks.every((check) => check.ok))
        return { ...state, checks, error: 'Not everything is connected yet. Follow the next step shown above.' };
    if (state.choice === 'chatgpt-events') await markWebAdded('chatgpt', await savedPublicUrl());
    await writePhase('complete');
    onComplete();
    return { ...state, checks };
}

const initial: State = { step: 'loading', input: '', selected: 0, draft: { token: '', ownerId: '', channelId: '' }, busy: 'Loading…' };
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

function usePhase(setState: Setter): void {
    useEffect(() => {
        void Promise.all([onboardingPhase(process.env), readOperatorConfig()]).then(([phase, config]) =>
            setState((current) => ({ ...current, ...resumed(phase, config.mode), busy: undefined })),
        );
    }, [setState]);
}

function useLocalConnect(state: State, setState: Setter): void {
    const app = state.step === 'connect' && !state.busy && !state.error && !state.notice ? responderApps[state.choice!] : undefined;
    useEffect(() => {
        if (!app) return;
        setState((current) => ({ ...current, busy: `Connecting ${appNames[app]}…` }));
        void connectApp(app)
            .then((notice) => setState((current) => ({ ...current, busy: undefined, notice })))
            .catch((error: unknown) => setState((current) => ({ ...current, busy: undefined, error: message(error, 'Install failed.') })));
    }, [app, setState]);
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
    useLocalConnect(state, setState);
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
