import ipaddr from 'ipaddr.js';
import { localCall, localEndpoint } from '../mcp/local-client.js';
import { localModes, type OperatorConfig, type OperatingMode } from './config.js';

export const isLocal = (mode: OperatingMode) => localModes.includes(mode);

function localAddress(host: string): boolean {
    return (
        !host.includes('.') ||
        /(^|\.)(localhost|local|internal|test)$/.test(host) ||
        (ipaddr.isValid(host) && ipaddr.parse(host).range() !== 'unicast')
    );
}

export function publicEndpoint(value: string): string {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const localHost = localAddress(host);
    const credentials = Boolean(url.username || url.password);
    if (url.protocol !== 'https:' || credentials || url.search || url.hash || localHost)
        throw new Error('Use a public HTTPS domain without credentials, query or fragment.');
    if (url.pathname === '/') url.pathname = '/mcp';
    return url.href;
}
export function endpointError(value: string): string | undefined {
    try {
        publicEndpoint(value);
    } catch {
        return 'Use a public HTTPS domain, e.g. bot.example.com. Not a local address.';
    }
}
export function timeoutError(value: string): string | undefined {
    if (!/^\d+$/.test(value) || Number(value) < 30 || Number(value) > 1800) return 'Use a whole number from 30 to 1800 seconds.';
}
export interface LiveSetupStatus {
    approvedPeopleRevision?: string;
    gateway: string;
    operator: {
        mode: string;
        appliedConfigAt: string | null;
        activeEventId?: string | null;
        blockedReason?: string | null;
        supportedConfigVersion?: number;
    };
    events: { subscriptions: number };
}
export async function liveSetupStatus(): Promise<LiveSetupStatus | null> {
    try {
        const result = await localCall(await localEndpoint(), 'tools/call', { name: 'discordinator_status', arguments: {} }, 2000);
        const content = (result.content as { type: string; text?: string }[] | undefined)?.find((item) => item.type === 'text')?.text;
        const status = content ? (JSON.parse(content) as LiveSetupStatus) : null;
        return status?.operator && status.events ? status : null;
    } catch {
        return null;
    }
}
export function activationBlock(config: OperatorConfig, live: LiveSetupStatus | null, ready: boolean): string | undefined {
    if (!live) return 'Live status unavailable. Start the bridge or verify access before activating.';
    if (live.operator.activeEventId) return 'A local request is running. Wait before changing responders.';
    if (!ready) return 'Complete prerequisites first, or save settings paused.';
}
