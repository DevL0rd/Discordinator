export class ProcessingIndicator {
    private active = new Map<string, { eventId: string; since: number }>();
    private timer?: ReturnType<typeof setInterval>;
    constructor(
        readonly typing: (eventId: string) => Promise<void>,
        readonly now = Date.now,
        readonly maxMs = 10 * 60_000,
    ) {}
    set(sessionId: string, eventId: string, processing: boolean): void {
        if (processing) this.active.set(sessionId, { eventId, since: this.now() });
        else this.active.delete(sessionId);
        if (!this.active.size) {
            clearInterval(this.timer);
            this.timer = undefined;
            return;
        }
        if (!this.timer) {
            this.timer = setInterval(() => void this.pulse(), 8000);
            this.timer.unref();
        }
        if (processing) void this.pulse();
    }
    async pulse(): Promise<void> {
        for (const [sessionId, { eventId, since }] of this.active) {
            if (this.now() - since > this.maxMs) {
                this.active.delete(sessionId);
                continue;
            }
            try {
                await this.typing(eventId);
            } catch {
                this.active.delete(sessionId);
            }
        }
        if (!this.active.size) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    stop(): void {
        this.active.clear();
        clearInterval(this.timer);
        this.timer = undefined;
    }
}
