import { verifyLines, type Check } from './onboarding-verify.js';
import { inviteCopy, inviteReady, ownerMatches } from './onboarding-invite.js';
import { appNames, responderApps } from './connections.js';
import type { AiChoice, DiscordDiscovery, DiscordDraft, DiscordIdentity } from './onboarding-store.js';
import type { StepView } from './onboarding-view.js';
import { assistants } from './ui/status.js';

export type Step =
    | 'loading'
    | 'welcome'
    | 'token'
    | 'invite'
    | 'owner'
    | 'channel'
    | 'discord-review'
    | 'ai'
    | 'domain'
    | 'password'
    | 'password-confirm'
    | 'ai-review'
    | 'connect'
    | 'service'
    | 'verify';
export interface State {
    step: Step;
    input: string;
    selected: number;
    draft: DiscordDraft;
    identity?: DiscordIdentity;
    discovery?: DiscordDiscovery;
    choice?: AiChoice;
    domain?: string;
    password?: string;
    checks?: Check[];
    evidence?: string;
    busy?: string;
    error?: string;
    notice?: string;
}
export const choices: AiChoice[] = ['claude-session', 'codex-local', 'chatgpt-events', 'manual-mcp'];
const stageOf: Record<Step, number> = {
    loading: 0,
    welcome: 0,
    token: 0,
    invite: 0,
    owner: 0,
    channel: 0,
    'discord-review': 0,
    ai: 1,
    domain: 1,
    password: 1,
    'password-confirm': 1,
    'ai-review': 1,
    connect: 2,
    service: 3,
    verify: 3,
};
export const textSteps: Step[] = ['token', 'owner', 'channel', 'domain', 'password', 'password-confirm'];
const maskedSteps: Step[] = ['token', 'password', 'password-confirm'];
export const startable = (checks: Check[] | undefined): boolean => Boolean(checks?.every((check) => check.ok || check.start));

export function buttonsFor(state: State): string[] {
    const sets: Partial<Record<Step, string[]>> = {
        welcome: ['Begin'],
        invite: inviteReady(state.discovery) ? ['Continue'] : ['Open invite', 'Check again'],
        'discord-review': state.identity ? ['Save', 'Back'] : ['Verify'],
        'ai-review': ['Save', 'Back'],
        connect: state.error ? ['Retry', 'Skip'] : ['Continue'],
        service: ['Skip', 'Install', 'Back'],
        verify: startable(state.checks) ? ['Finish'] : ['Check again'],
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

export const count = (state: State): number => optionsFor(state)?.length ?? buttonsFor(state).length;

const passwordCopy = {
    password: {
        title: 'Choose a sign-in password',
        body: [
            'Apps that reach Discordinator through your public domain, like ChatGPT and Claude on the web, sign in with this password. There is no username.',
            'At least 12 characters. You can change it later on the Apps page.',
        ],
    },
    confirm: { title: 'Confirm the password', body: ['Type the same password once more.'] },
};

const reviewNote = (choice?: AiChoice) =>
    choice === 'manual-mcp' ? 'Your MCP app connects to Discordinator and answers by itself.' : 'It starts when you finish setup.';

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
        domain: () => ({
            title: 'Your public domain',
            body: [
                'Just the domain ChatGPT reaches Discordinator on, like bot.example.com. No https:// and no path.',
                `Point it (Cloudflare Tunnel or a reverse proxy) at http://127.0.0.1:${process.env.DISCORDINATOR_PORT ?? '8787'}, the port Discordinator listens on.`,
            ],
        }),
        invite: () => inviteCopy(state.discovery),
        password: () => passwordCopy.password,
        'password-confirm': () => passwordCopy.confirm,
        verify: () => ({ title: 'Make sure it works', body: verifyLines(state.checks) }),
        'ai-review': () => ({
            title: 'Ready to save',
            body: [assistants[state.choice ?? 'claude-session'].name, state.evidence ?? '', reviewNote(state.choice)],
        }),
        connect: () => ({
            title: `Connect ${appNames[responderApps[state.choice ?? 'claude-session'] ?? 'claude-code']}`,
            body: ['Discordinator connects it on this computer so it gets the Discord tools. Nothing to sign in to.'],
        }),
        service: () => ({
            title: 'Install Discordinator',
            body: [
                'Installs Discordinator with its own copy and a background service that starts when you log in. Afterwards, type discordinator in any terminal to open this app, and you can delete the folder you cloned.',
                'A Discordinator you started by hand is never stopped.',
            ],
        }),
    };
    return copies[state.step]();
}

export function stepView(state: State, tick: number): StepView {
    const options = optionsFor(state);
    const view: StepView = { stage: stageOf[state.step], ...copy(state), selected: state.selected, tick, buttons: buttonsFor(state) };
    if (options) view.options = options;
    if (state.step === 'ai') view.tags = choices.map((choice) => assistants[choice].tag);
    if (textSteps.includes(state.step)) view.input = { value: state.input, masked: maskedSteps.includes(state.step) };
    for (const key of ['notice', 'error', 'busy'] as const) if (state[key]) view[key] = state[key];
    return view;
}
