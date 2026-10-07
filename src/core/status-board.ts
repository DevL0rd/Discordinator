import { fade } from './fade.js';

export interface Posted {
    id: string;
    channel_id: string;
}

export class StatusBoard {
    private readonly posted = new Map<string, { message: Posted; timer: NodeJS.Timeout }>();
    private readonly chains = new Map<string, Promise<unknown>>();

    constructor(private readonly remove: (message: Posted) => Promise<unknown>) {}

    private serial<T>(eventId: string, work: () => Promise<T>): Promise<T> {
        const next = (this.chains.get(eventId) ?? Promise.resolve()).catch(() => undefined).then(work);
        this.chains.set(eventId, next);
        void next
            .finally(() => {
                if (this.chains.get(eventId) === next) this.chains.delete(eventId);
            })
            .catch(() => undefined);
        return next;
    }

    show(eventId: string, post: () => Promise<Posted>, edit: (message: Posted) => Promise<unknown>): Promise<Posted> {
        return this.serial(eventId, async () => {
            const current = this.posted.get(eventId);
            let message = current?.message;
            if (message) await edit(message).catch(() => (message = undefined));
            message ??= await post();
            clearTimeout(current?.timer);
            const timer = setTimeout(() => void this.clear(eventId), fade.ms);
            timer.unref();
            this.posted.set(eventId, { message, timer });
            return message;
        });
    }

    clear(eventId: string): Promise<void> {
        return this.serial(eventId, async () => {
            const current = this.posted.get(eventId);
            if (!current) return;
            this.posted.delete(eventId);
            clearTimeout(current.timer);
            await this.remove(current.message).catch(() => undefined);
        });
    }
}
