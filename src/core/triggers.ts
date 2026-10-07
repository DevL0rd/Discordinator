import type { Policy } from './policy.js';

function escaped(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Triggers {
    constructor(readonly policy: Policy) {}

    private get names(): RegExp[] {
        return this.policy.names().map((name) => new RegExp(`(?<![\\p{L}\\p{N}_])${escaped(name)}(?![\\p{L}\\p{N}_])`, 'iu'));
    }

    accepts(actorId: string, content: string, botId: string): boolean {
        this.policy.assertUser(actorId);
        if (new RegExp(`<@!?${botId}>`).test(content)) return true;
        return this.policy.config.triggers.matchNames && this.named(content);
    }

    named(content: string): boolean {
        return this.names.some((pattern) => pattern.test(content));
    }

    approvalId(content: string, botId: string, slash = false): string | null {
        const id = '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
        if (slash) return new RegExp(`^\\s*approve\\s+${id}\\s*$`, 'i').exec(content)?.[1]?.toLowerCase() ?? null;
        const names = this.policy.config.triggers.matchNames ? this.policy.names().map(escaped) : [];
        const prefix = [`<@!?${botId}>`, ...names].join('|');
        return new RegExp(`^\\s*(?:${prefix})[,:!]?\\s+approve\\s+${id}\\s*$`, 'iu').exec(content)?.[1]?.toLowerCase() ?? null;
    }
}
