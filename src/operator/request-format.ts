import { describePerson, mentionNote, person, readableText, type Person } from '../core/directory.js';
import type { Policy } from '../core/policy.js';
import type { BotEvent } from '../core/queue.js';

export function spoken(text: string, mentions?: readonly Person[]): string {
    const note = mentionNote(text, mentions);
    return note ? `${readableText(text, mentions)} [${note}]` : readableText(text, mentions);
}

export function speaker(policy: Policy, actorId: string, author?: Person): string {
    return `${describePerson(author ?? person(actorId))}${policy.isOwner(actorId) ? ' · owner' : ''}`;
}

export function requestText(policy: Policy, event: BotEvent): string {
    const place = event.guildId ? `#${event.channelId}` : 'DM';
    const kind = { message: 'Discord', interaction: 'Discord answer', voice: 'Discord voice call (spoken; your reply is read aloud)' }[
        event.kind
    ];
    return `${kind} · ${place} · from ${speaker(policy, event.actorId, event.author)}\n${spoken(event.text, event.mentions)}`;
}
