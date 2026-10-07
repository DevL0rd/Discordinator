export interface Posted {
    id: string;
    channel_id: string;
}

interface Anchor {
    message: Posted;
    base: string;
    steps: string[];
}

const shownSteps = 6;
const limit = 2000;

export function statusSection(steps: string[]): string {
    const recent = steps.slice(-shownSteps);
    const done = recent.slice(0, -1).map((step) => `> -# ✓ ${step}`);
    return ['> ⏳ **Working on it**', ...done, `> **›** ${recent.at(-1) ?? ''}`].join('\n');
}

function withSection(base: string, steps: string[]): string {
    const section = statusSection(steps.map((step) => step.replace(/\s+/g, ' ').trim()).filter(Boolean));
    const text = base ? `${base}\n\n${section}` : section;
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export class StatusBoard {
    private readonly anchors = new Map<string, Anchor>();
    private readonly chains = new Map<string, Promise<unknown>>();

    constructor(
        private readonly edit: (message: Posted, content: string) => Promise<unknown>,
        private readonly remove: (message: Posted) => Promise<unknown>,
    ) {}

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

    show(eventId: string, step: string, post: (content: string) => Promise<Posted>): Promise<Posted> {
        return this.serial(eventId, async () => {
            const anchor = this.anchors.get(eventId);
            if (anchor) {
                if (anchor.steps.at(-1) === step) return anchor.message;
                anchor.steps.push(step);
                const edited = await this.edit(anchor.message, withSection(anchor.base, anchor.steps)).then(
                    () => true,
                    () => false,
                );
                if (edited) return anchor.message;
            }
            const steps = [step];
            const message = await post(withSection('', steps));
            this.anchors.set(eventId, { message, base: '', steps });
            return message;
        });
    }

    settle(eventId: string, reply?: { message: Posted; content: string }): Promise<void> {
        return this.serial(eventId, async () => {
            const anchor = this.anchors.get(eventId);
            if (anchor?.steps.length)
                await (anchor.base ? this.edit(anchor.message, anchor.base) : this.remove(anchor.message)).catch(() => undefined);
            if (reply && reply.content.length <= limit)
                this.anchors.set(eventId, { message: reply.message, base: reply.content, steps: [] });
            else this.anchors.delete(eventId);
        });
    }
}
