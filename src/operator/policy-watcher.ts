import { readFile } from 'node:fs/promises';
import { policySchema } from '../core/config.js';
import type { Policy } from '../core/policy.js';
import type { ReplyOrigins } from '../core/reply-origins.js';
import { watchFile } from './file-watch.js';

export class PolicyWatcher {
    private unwatch?: () => void;
    private work: Promise<void> = Promise.resolve();
    constructor(
        readonly path: string,
        readonly policy: Policy,
        readonly origins: ReplyOrigins,
    ) {}
    start(): void {
        this.unwatch = watchFile(this.path, () => {
            this.work = this.work.then(() =>
                this.reload().catch(() => {
                    console.error('Policy reload failed; the previous policy stays in effect');
                }),
            );
        });
    }
    async stop(): Promise<void> {
        this.unwatch?.();
        await this.work;
    }
    private async reload(): Promise<void> {
        const next = policySchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
        const removed = this.policy.config.allowedUserIds.filter((id) => !next.allowedUserIds.includes(id));
        if (removed.length) await this.origins.revokeActors(removed);
        this.policy.update(next);
        console.error('Policy reloaded');
    }
}
