import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { publicDomain } from './connection-domain.js';

export interface McpEntry {
    name: string;
    url: string;
    status: string;
}
export type ConnectorState = 'connected' | 'needs-sign-in' | 'moved' | 'missing';

export function parseMcpList(text: string): McpEntry[] {
    return text.split('\n').flatMap((row) => {
        const match = /^(.+?): (\S+)(?: \([^)]*\))? - (.+)$/.exec(row.trim());
        return match ? [{ name: match[1]!, url: match[2]!, status: match[3]! }] : [];
    });
}

export async function publicMcpUrl(home = process.cwd()): Promise<string | undefined> {
    const environment = await readFile(join(home, '.env'), 'utf8').then(parseEnv, (): Record<string, string> => ({}));
    const domain = publicDomain(process.env.DISCORDINATOR_RESOURCE_URL ?? environment.DISCORDINATOR_RESOURCE_URL);
    return domain ? `https://${domain}/mcp` : undefined;
}

export function connectorState(entries: McpEntry[], url: string): ConnectorState {
    const web = entries.filter((entry) => entry.name.startsWith('claude.ai '));
    const current = web.find((entry) => entry.url === url);
    if (current) return /connected/i.test(current.status) ? 'connected' : 'needs-sign-in';
    return web.some((entry) => /discordinator/i.test(entry.name)) ? 'moved' : 'missing';
}

export const connectorText: Record<ConnectorState, string> = {
    connected: 'Connected',
    'needs-sign-in': 'Needs sign-in',
    moved: 'Address changed',
    missing: 'Not connected',
};
