import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const stateFile = '.data/web-connectors.json';
const stateSchema = z.object({ claude: z.string().optional(), chatgpt: z.string().optional() });
export type WebConnectors = z.infer<typeof stateSchema>;
export type WebId = keyof WebConnectors;

export async function webConnectors(): Promise<WebConnectors> {
    const parsed = stateSchema.safeParse(JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}')));
    return parsed.success ? parsed.data : {};
}

async function saveWebConnectors(next: WebConnectors): Promise<void> {
    await mkdir('.data', { recursive: true, mode: 0o700 });
    await writeFile(`${stateFile}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
}

export async function markWebAdded(id: WebId, url: string): Promise<string> {
    await saveWebConnectors({ ...(await webConnectors()), [id]: url });
    return 'Saved. Discordinator will tell you if your public address changes.';
}

export async function forgetWebConnectors(): Promise<void> {
    await saveWebConnectors({});
}

export const claudeConnectorLink = (url: string): string =>
    `https://claude.ai/customize/connectors?${new URLSearchParams({ modal: 'add-custom-connector', connectorName: 'Discordinator', connectorUrl: url })}`;

export function connectorStatus(added: string | undefined, url: string | undefined): { text: string; current: boolean } {
    if (!added) return { text: 'Not connected', current: false };
    if (url && added !== url) return { text: 'Address changed', current: false };
    return { text: 'Connected', current: true };
}
