import { serverState, type ServerInfo } from '../../servers.js';
import { line, span } from '../canvas.js';
import { actionItem, card, heading, note, pill } from '../items.js';
import type { Item, View } from '../model.js';
import { color } from '../theme.js';

function serverCard(server: ServerInfo, view: View): Item {
    const state = serverState(view.drafts.policy, server);
    const total = server.channels.length;
    const [text, fg, badge] = !state.allowed
        ? ['Not answering here', color.muted, pill('Off', 'idle')]
        : !state.channels.length
          ? ['Allowed, but no channels chosen yet', color.amber, pill('No channels', 'warn')]
          : [`Answers in ${state.channels.length} of ${total} channel${total === 1 ? '' : 's'}`, color.soft, pill('Answering', 'good')];
    return card({
        id: `server:${server.id}`,
        intent: { type: 'server', id: server.id },
        title: server.name,
        badge,
        body: [line([span(text, fg)])],
    });
}

export function serverItems(view: View): Item[] {
    const bot = view.extras.servers;
    const count = bot?.servers.length ?? 0;
    return [
        heading('servers', 'Servers', bot ? `${count} server${count === 1 ? '' : 's'} · select one to manage it` : 'Loading servers…'),
        actionItem('invite-server', '+ Invite to another server', { type: 'server' }, 'Opens Discord in your browser'),
        ...(bot?.servers ?? []).map((server) => serverCard(server, view)),
        ...(bot && !count
            ? [note('servers-empty', 'The bot is not in any server yet. Invite it, then press R to refresh.', color.amber)]
            : []),
    ];
}
