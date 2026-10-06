import { useEffect } from 'react';
import { parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { appNames, appState, responderApps } from './connections.js';
import { readOperatorConfig } from './config.js';
import { publicDomain } from './connection-domain.js';
import { watchFile } from './file-watch.js';
import { presenceFile, readPresence } from './presence.js';
import { liveSetupStatus } from './setup-model.js';
import { chatgptHowTo } from './ui/status.js';
import type { AiChoice } from './onboarding-store.js';

export interface Check {
    label: string;
    ok: boolean;
    hint: string;
}

export async function savedPublicUrl(): Promise<string> {
    const environment = parseEnv(await readFile('.env', 'utf8').catch(() => ''));
    return `https://${publicDomain(environment.DISCORDINATOR_RESOURCE_URL)}/mcp`;
}

async function chatgptChecks(choice: AiChoice, subscriptions: number): Promise<Check[]> {
    const url = await savedPublicUrl();
    const connected = Boolean((await readPresence()).remoteAt);
    const checks: Check[] = [
        {
            label: 'ChatGPT is connected',
            ok: connected,
            hint: `In ChatGPT open Settings, Apps & Connectors, turn on Developer mode, create a connector named Discordinator with ${url}, and sign in with your password.`,
        },
    ];
    if (choice === 'chatgpt-events') checks.push({ label: 'Automatic wake-ups are on', ok: subscriptions > 0, hint: chatgptHowTo });
    return checks;
}

export async function verifyChecks(choice?: AiChoice): Promise<Check[]> {
    const mode = choice ?? (await readOperatorConfig()).mode;
    const live = await liveSetupStatus();
    const checks: Check[] = [
        {
            label: 'Discordinator is running',
            ok: Boolean(live),
            hint: 'Go back and install the background service, or start Discordinator with npm start.',
        },
    ];
    const app = responderApps[mode];
    if (app) {
        const state = await appState(app);
        checks.push({
            label: `${appNames[app]} is connected`,
            ok: state.connected,
            hint: `${appNames[app]}: ${state.status}. Go back and connect it.`,
        });
    }
    if (mode.startsWith('chatgpt-')) checks.push(...(await chatgptChecks(mode, live?.events.subscriptions ?? 0)));
    return checks;
}

export function verifyLines(checks: Check[] | undefined): string[] {
    if (!checks) return ['Checking that everything works…'];
    const pending = checks.find((check) => !check.ok);
    return [
        ...checks.map((check) => `${check.ok ? '✓' : '○'} ${check.label}`),
        pending ? `Next: ${pending.hint}` : 'Everything is connected and working.',
    ];
}

export function useVerify(active: boolean, choice: AiChoice | undefined, set: (checks: Check[]) => void): void {
    useEffect(() => {
        if (!active) return;
        const run = () => void verifyChecks(choice).then(set, () => undefined);
        run();
        const stops = [watchFile(presenceFile, run), watchFile('.data/operator.json', run)];
        return () => stops.forEach((stop) => stop());
    }, [active, choice, set]);
}
