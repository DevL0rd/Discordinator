import assert from 'node:assert/strict';
import { pageItems } from '../src/operator/ui/pages/index.js';
import { card, setting, settingItem, statusItem } from '../src/operator/ui/items.js';
import { frame } from '../src/operator/ui/frame.js';
import { viewOf, type UiState } from '../src/operator/ui/state.js';
import type { Line } from '../src/operator/ui/canvas.js';
import { pages, type PageId, type View } from '../src/operator/ui/model.js';
import stringWidth from 'string-width';
import type { LiveSetupStatus } from '../src/operator/setup-model.js';
import { observed, uiStore } from './ui-fixtures.js';

const text = (lines: Line[]) => lines.map((row) => row.spans.map((item) => item.text).join('')).join('\n');
const pageText = (state: UiState, page: PageId) => {
    const view = viewOf(state);
    return text(pageItems(page, view).flatMap((item) => item.lines(300, false, view)));
};
type Patch = {
    drafts?: Partial<Record<'operator' | 'policy' | 'environment', Record<string, unknown>>>;
    live?: Partial<LiveSetupStatus> | null;
};
function state(patch: Patch = {}, extra: Partial<UiState> = {}): UiState {
    const base = uiStore().state;
    const drafts = {
        operator: { ...base.drafts.operator, ...patch.drafts?.operator },
        policy: { ...base.drafts.policy, ...patch.drafts?.policy },
        environment: { ...base.drafts.environment, ...patch.drafts?.environment },
    };
    const live = patch.live === null ? null : { ...observed.live!, ...patch.live };
    return { ...base, drafts, observed: { ...base.observed, live }, ...extra };
}
const liveMode = (mode: string, more: Record<string, unknown> = {}) => ({ operator: { mode, appliedConfigAt: null, ...more } });

function checkApps(): void {
    const web = { claude: 'https://bot.example.com/mcp', chatgpt: 'https://old.example.com/mcp' };
    const apps = pageText(state({}, { extras: { apps: {}, web } }), 'apps');
    assert.ok(apps.includes('Reached through bot.example.com'));
    assert.ok(apps.includes(' CONNECTED ') && apps.includes('Added. Open it to see the steps again.'), 'a current connector is connected');
    assert.ok(apps.includes(' ADDRESS CHANGED ') && apps.includes('Your public address changed'), 'an old address is flagged');
    assert.ok(apps.includes('http://127.0.0.1:8787'), 'the default port is shown');
    const fresh = pageText(state({ drafts: { environment: { DISCORDINATOR_PORT: 9000 } } }), 'apps');
    assert.ok(fresh.includes(' NOT CONNECTED ') && fresh.includes('http://127.0.0.1:9000'), 'a custom port is shown');
    const local = pageText(state({ drafts: { environment: { DISCORDINATOR_RESOURCE_URL: '' } } }), 'apps');
    assert.ok(local.includes('Set a public domain below to use these') && local.includes(' NEEDS A PUBLIC DOMAIN '));
}

function checkDiscord(): void {
    const reach = (policy: Record<string, unknown>) =>
        /Discordinator answers in ([^.]+)\./.exec(pageText(state({ drafts: { policy } }), 'discord'))?.[1];
    assert.equal(reach({}), 'every server, in no channels (the allowlist is empty)', 'the fixture blocks nothing and lists no channels');
    assert.equal(
        reach({ servers: undefined, channels: undefined }),
        'no servers (the allowlist is empty), in no channels (the allowlist is empty)',
    );
    assert.equal(
        reach({
            servers: { mode: 'blocklist', allowed: [], blocked: ['1', '2'] },
            channels: { mode: 'allowlist', allowed: ['3', '4'], blocked: ['4'] },
        }),
        'every server except 2 blocked servers, in only 1 listed channel',
    );
    assert.equal(
        reach({ channels: { mode: 'blocklist', allowed: [], blocked: ['5'] } }),
        'every server, in every channel except 1 blocked channel',
    );
    assert.equal(
        reach({ servers: { mode: 'allowlist', allowed: ['1', '2'], blocked: [] } }),
        'only 2 listed servers, in no channels (the allowlist is empty)',
    );
    const blocklist = pageText(
        state({
            drafts: {
                policy: {
                    servers: { mode: 'allowlist', allowed: [], blocked: [] },
                    channels: { mode: 'blocklist', allowed: [], blocked: [] },
                },
            },
        }),
        'discord',
    );
    assert.ok(blocklist.includes('Works in every channel the bot can see, except blocked ones.'));
    assert.ok(blocklist.includes('Works only in listed servers. Blocked servers always win.'));
}

function checkHome(): void {
    const activity = [{ at: '10:00', text: 'Saved.', tone: 'good' as const }];
    const busy = pageText(state({ live: liveMode('codex-local', { appliedConfigAt: observed.active.updatedAt }) }, { activity }), 'home');
    assert.ok(busy.includes('10:00') && busy.includes('Saved.'), 'recent activity is listed');
    assert.ok(!busy.includes('Nothing yet.'));
    assert.ok(busy.includes('Pause') && !busy.includes('Needs attention'), 'a running assistant can be paused');
    const outdated = pageText(state({ live: null }, { observed: { ...observed, live: null, runtime: true } }), 'home');
    assert.ok(outdated.includes('older build'), 'a running bridge without status needs a restart');
    assert.ok(outdated.includes('Start Codex') && outdated.includes('Begin answering Discord'));
    const pending = pageText(state({ live: liveMode('codex-local') }), 'home');
    assert.ok(pending.includes('You saved Codex, but it is not active yet.') && pending.includes('Waiting for Discordinator to switch'));
    const paused = pageText(state({ live: liveMode('disabled') }), 'home');
    assert.ok(paused.includes('CODEX'), 'a paused bridge shows the saved responder');
    const unknown = pageText(state({ live: liveMode('mystery') }), 'home');
    assert.ok(unknown.includes('ASSISTANT') && unknown.includes('External'), 'an unknown responder is shown generically');
    const changed = state({ drafts: { operator: { instructions: 'Hi' } } });
    assert.ok(pageText(changed, 'home').includes('1 unsaved change. Press S to review.'));
    const twice = state({ drafts: { operator: { instructions: 'Hi', progressSeconds: 30 } } });
    assert.ok(pageText(twice, 'home').includes('2 unsaved changes.'));
}

function checkSystem(): void {
    const service = (active: boolean, installed: boolean) =>
        pageText(state({}, { observed: { ...observed, service: { available: true, installed, active } } }), 'system');
    const running = service(true, true);
    assert.ok(running.includes('Reinstall service') && running.includes('Restart Discordinator'), 'a running service can be restarted');
    const stopped = service(false, true);
    assert.ok(stopped.includes('Reinstall service') && !stopped.includes('Restart Discordinator'));
    assert.ok(service(false, false).includes('Install service'));
    assert.ok(running.includes('.data/setup-backups'));
}

function checkAssistant(): void {
    const page = (patch: Patch, extra: Partial<UiState> = {}) => pageText(state(patch, extra), 'assistant');
    assert.ok(page({}).includes(' ACTIVE '), 'the running responder is marked active');
    assert.ok(page({ live: liveMode('claude-session') }).includes(' SAVED '), 'the saved responder is marked saved');
    const poll = page({ drafts: { operator: { mode: 'chatgpt-poll' } } });
    assert.ok(poll.includes(' SELECTED · UNSAVED '), 'a legacy mode is still offered when chosen');
    const desktop = page({
        drafts: { operator: { mode: 'claude-session' } },
        live: liveMode('claude-session', { session: { live: true } }),
    });
    assert.ok(desktop.includes('Live in Claude Desktop'));
    const subscribed = page(
        {
            drafts: { operator: { mode: 'chatgpt-events' }, policy: { mcpEvents: { enabled: true } } },
            live: { events: { subscriptions: 2 } },
        },
        { extras: { apps: {}, password: true, web: { chatgpt: 'https://bot.example.com/mcp' } } },
    );
    assert.equal(subscribed.split('✓').length - 1, 5, 'every ChatGPT step is checked off');
    const offline = page({ drafts: { operator: { mode: 'chatgpt-events' } }, live: null });
    assert.ok(offline.includes('○ A ChatGPT chat turned on wake-ups'), 'wake-ups are unchecked while Discordinator is stopped');
}

function checkSignals(): void {
    const header = (patch: Patch, extra: Partial<UiState> = {}) => {
        const current = state(patch, extra);
        const view = viewOf(current);
        return frame({
            view,
            page: 'home',
            focus: 'content',
            items: pageItems('home', view),
            selected: 3,
            scroll: 0,
            width: 120,
            height: 30,
        });
    };
    const events = text(
        header({ live: liveMode('chatgpt-events', { appliedConfigAt: observed.active.updatedAt }), drafts: {} }).lines.slice(0, 1),
    );
    assert.ok(events.includes('Waiting'), 'ChatGPT without a subscription is waiting');
    const listening = header({ live: { ...liveMode('chatgpt-events'), events: { subscriptions: 1 } } });
    assert.ok(text(listening.lines.slice(0, 1)).includes('Listening'));
    const off = header({ live: liveMode('disabled'), drafts: { environment: { DISCORDINATOR_RESOURCE_URL: '' } } });
    assert.ok(text(off.lines.slice(0, 1)).includes('No assistant active'), 'a paused bridge names no assistant');
    assert.ok(!text(off.lines.slice(0, 1)).includes('bot.example.com'), 'no domain is shown without one');
    const busy = header({}, { busy: 'Saving…', tick: 3 });
    assert.ok(text(busy.lines.slice(-2)).includes('Saving…'), 'the footer shows the busy task');
    const view = viewOf(state());
    const items = pageItems('system', view);
    const scrolled = frame({ view, page: 'system', focus: 'content', items, selected: 2, scroll: 40, width: 120, height: 24 });
    assert.ok(scrolled.scroll < 5, 'scrolling back up keeps the selection visible');
    const last = items.findLastIndex((item) => item.intent);
    const down = frame({ view, page: 'system', focus: 'content', items, selected: last, scroll: 0, width: 120, height: 24 });
    assert.ok(down.scroll > 0, 'scrolling down keeps the selection visible');
}

function checkItems(): void {
    const view: View = viewOf(
        state({ drafts: { policy: { allowedUserIds: ['1', '2', '3', '4'], allowedRoleIds: ['9'], triggers: { names: ['dot', 'bot'] } } } }),
    );
    const shown = (id: string) => text(settingItem(id).lines(100, true, view));
    assert.match(shown('policy.allowedUserIds'), /4 people/, 'long or private lists are counted');
    assert.match(shown('policy.allowedRoleIds'), /9/, 'short lists are listed');
    assert.match(shown('policy.triggers.names'), /dot, bot/);
    assert.match(shown('policy.scopes'), /None/);
    const scopes = (chosen: readonly string[]) =>
        text(settingItem('policy.scopes').lines(100, false, viewOf(state({ drafts: { policy: { scopes: [...chosen] } } }))));
    assert.match(scopes(['messages.read']), /1 of \d+/, 'checklists show how many are chosen');
    assert.match(scopes(setting('policy.scopes').choices!), /All \d+/);
    assert.match(shown('policy.media.maxFileBytes'), /2 MB/, 'byte sizes are shown in megabytes');
    const restart = viewOf(state({ drafts: { environment: { DISCORDINATOR_PORT: 9000 } } }));
    assert.doesNotMatch(
        text(settingItem('environment.DISCORDINATOR_PORT').lines(100, false, restart)),
        /restart/,
        'Changed settings never say they wait for a restart',
    );
    assert.throws(() => settingItem('policy.nothing'), /Unknown setting policy.nothing/);
    const status = statusItem('s', 'Label', 'Value', 'good', { type: 'save' });
    assert.deepEqual(status.intent, { type: 'save' }, 'a status row can be actionable');
    const plain = card({ id: 'c', title: 'Plain card', body: [] });
    assert.equal(plain.intent, undefined);
    assert.ok(text(plain.lines(60, false, view)).includes('Plain card'), 'a card needs no badge');
}

function checkIconWidths(): void {
    for (const page of pages)
        assert.equal(
            stringWidth(page.icon, { ambiguousIsNarrow: false }),
            1,
            `The ${page.label} menu icon is one column wide in every terminal, so rows never wrap and clicks stay aligned`,
        );
}

export function checkUiPages(): void {
    checkIconWidths();
    checkApps();
    checkDiscord();
    checkHome();
    checkSystem();
    checkAssistant();
    checkSignals();
    checkItems();
}
