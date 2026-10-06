import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';

const exec = promisify(execFile);
const stateFile = '.data/web-connectors.json';
const stateSchema = z.object({ chatgpt: z.string().optional() });
export type WebConnectors = z.infer<typeof stateSchema>;

export async function webConnectors(): Promise<WebConnectors> {
    const parsed = stateSchema.safeParse(JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}')));
    return parsed.success ? parsed.data : {};
}

export async function markChatgptAdded(url: string): Promise<string> {
    const next = { ...(await webConnectors()), chatgpt: url };
    await mkdir('.data', { recursive: true, mode: 0o700 });
    await writeFile(`${stateFile}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
    return 'Saved. Discordinator will tell you if your public address changes.';
}

export async function forgetChatgpt(): Promise<void> {
    const { chatgpt: _forgotten, ...rest } = await webConnectors();
    await mkdir('.data', { recursive: true, mode: 0o700 });
    await writeFile(`${stateFile}.tmp`, JSON.stringify(rest), { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
}

export const claudeConnectorLink = (url: string): string =>
    `https://claude.ai/customize/connectors?${new URLSearchParams({ modal: 'add-custom-connector', connectorName: 'Discordinator', connectorUrl: url })}`;

export async function openInBrowser(url: string): Promise<void> {
    await exec('xdg-open', [url]);
}

export const openClaudeConnector = (url: string) => openInBrowser(claudeConnectorLink(url));

export function connectorStatus(added: string | undefined, url: string | undefined): { text: string; current: boolean } {
    if (!added) return { text: 'Not connected', current: false };
    if (url && added !== url) return { text: 'Address changed', current: false };
    return { text: 'Connected', current: true };
}
