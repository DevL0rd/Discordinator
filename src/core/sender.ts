import { createHash } from 'node:crypto';
import { project } from '../discord/api.js';
import { mentions } from '../discord/operations.js';
import type { Bridge, Rich } from './bridge.js';
import type { Delivery } from './queue.js';

export type OutFile = NonNullable<Delivery['files']>[number] & { sha256: string };

export interface SendInput extends Rich {
    eventId?: string;
    channelId?: string;
    userId?: string;
    files: OutFile[];
    notifyUserId?: string;
    progress?: boolean;
    idempotencyKey: string;
}

const fingerprint = (input: SendInput) => ({
    ...input,
    files: input.files.map((file) => ({ name: file.name, sha256: file.sha256 })),
});

/** One way to send anything: a reply to a request, a post in an allowed channel, or a DM to an approved person, with optional files. */
export class Sender {
    constructor(private readonly bridge: Bridge) {}

    send(input: SendInput): Promise<unknown> {
        const targets = [input.eventId, input.channelId, input.userId].filter(Boolean).length;
        if (targets !== 1) throw new Error('Choose exactly one of eventId (reply to a request), channelId or userId (DM)');
        if (!input.content && !input.embeds?.length && !input.files.length) throw new Error('A message needs text, an embed or a file');
        if (input.eventId) return this.reply(input, input.eventId);
        if (input.channelId) return this.post(input, input.channelId);
        return this.direct(input, input.userId!);
    }

    private async reply(input: SendInput, eventId: string): Promise<unknown> {
        const { bridge } = this;
        const event = bridge.queue.authorize(eventId).event;
        if (input.notifyUserId && input.notifyUserId !== event.actorId) throw new Error('A reply can only ping the person who asked');
        const notifyRequester = input.notifyUserId === event.actorId;
        if (!input.files.length)
            return bridge.respond({
                eventId,
                content: input.content,
                ...(input.embeds ? { embeds: input.embeds } : {}),
                notifyRequester,
                status: input.progress === true,
                idempotencyKey: input.idempotencyKey,
            });
        bridge.policy.assertScope('media.write');
        return bridge.replyJournal.execute(input.idempotencyKey, { operation: 'send', ...fingerprint(input) }, () =>
            bridge.deliver(
                eventId,
                { content: input.content, ...(input.embeds ? { embeds: input.embeds } : {}), files: input.files },
                input.idempotencyKey,
            ),
        );
    }

    private async post(input: SendInput, channelId: string): Promise<unknown> {
        const { bridge } = this;
        if (!input.files.length)
            return bridge.proactive({
                channelId,
                content: input.content,
                ...(input.embeds ? { embeds: input.embeds } : {}),
                ...(input.notifyUserId ? { notifyUserId: input.notifyUserId } : {}),
                idempotencyKey: input.idempotencyKey,
            });
        const check = async () => {
            bridge.policy.assertProactive(channelId);
            bridge.policy.assertScope('media.write');
            if (input.notifyUserId) bridge.policy.assertUser(input.notifyUserId);
            if (!bridge.policy.dmUser(channelId)) await bridge.api.channel(channelId);
        };
        await check();
        return bridge.replyJournal.execute(input.idempotencyKey, { operation: 'send', ...fingerprint(input) }, async () => {
            await check();
            const notify = input.notifyUserId;
            const content =
                notify && !new RegExp(`<@!?${notify}>`).test(input.content) ? `<@${notify}> ${input.content}`.trim() : input.content;
            return project(
                await bridge.api.postFiles(
                    `/channels/${channelId}/messages`,
                    {
                        content,
                        ...(input.embeds ? { embeds: input.embeds } : {}),
                        allowed_mentions: notify ? { ...mentions, users: [notify] } : mentions,
                        nonce: createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24),
                        enforce_nonce: true,
                        attachments: input.files.map((file, id) => ({ id, filename: file.name })),
                    },
                    input.files,
                ),
            );
        });
    }

    private async direct(input: SendInput, userId: string): Promise<unknown> {
        const { bridge } = this;
        bridge.policy.assertUser(userId);
        if (!input.files.length)
            return bridge.proactiveDm({
                userId,
                content: input.content,
                ...(input.embeds ? { embeds: input.embeds } : {}),
                idempotencyKey: input.idempotencyKey,
            });
        const dm = (await bridge.api.post('/users/@me/channels', { recipient_id: userId })) as { id: string };
        bridge.policy.noteDm(dm.id, userId);
        return this.post({ ...input, userId: undefined, notifyUserId: undefined }, dm.id);
    }
}
