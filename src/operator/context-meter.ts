type Post = (eventId: string, text: string, key: string) => Promise<unknown>;

const thresholds = [90, 50];

function warningText(percent: number): string {
    return percent >= 90
        ? `⚠️ **Context ${percent}% full.** Run \`/compact\` now, or start fresh with \`/new\`.`
        : `⚠️ **Context ${percent}% full.** Use \`/compact\` when it suits you.`;
}

export class ContextMeter {
    private readonly percents = new Map<string, number>();
    private readonly warned = new Map<string, number>();

    constructor(readonly post: Post) {}

    percent(key: string): number | undefined {
        return this.percents.get(key);
    }

    record(key: string, percent: number, eventId?: string): void {
        this.percents.set(key, percent);
        const reached = thresholds.find((threshold) => percent >= threshold);
        if (!reached) {
            this.warned.delete(key);
            return;
        }
        if (reached <= (this.warned.get(key) ?? 0) || !eventId) return;
        this.warned.set(key, reached);
        void this.post(eventId, warningText(percent), `context-warning-${key}-${reached}-${Date.now()}`).catch(() => undefined);
    }
}
