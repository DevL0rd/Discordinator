import assert from 'node:assert/strict';
import { defaultOperatorConfig } from '../src/operator/config.js';
import { policySchema } from '../src/core/config.js';
import type { PanelSnapshot } from '../src/operator/panel-store.js';
import { hits, lineWidth } from '../src/operator/ui/canvas.js';
import { frame } from '../src/operator/ui/frame.js';
import { pages, type Observations } from '../src/operator/ui/model.js';
import { pageItems } from '../src/operator/ui/pages/index.js';
import { searchResults, sheetLines } from '../src/operator/ui/sheets.js';
import { savedDiffers } from '../src/operator/ui/status.js';
import { handleKey, type Key } from '../src/operator/ui/keys.js';
import { handleMouse } from '../src/operator/ui/mouse.js';
import { initialState, selectedIndex, viewOf, type UiState } from '../src/operator/ui/state.js';
import type { Store } from '../src/operator/ui/effects.js';
import { wizardFrame } from '../src/operator/onboarding-view.js';

const documents = {
    operator: { ...defaultOperatorConfig(), mode: 'codex-local' },
    policy: policySchema.parse({ servers: { mode: 'blocklist' } }),
    environment: {
        DISCORDINATOR_RESOURCE_URL: 'https://bot.example.com/mcp',
        DISCORD_BOT_TOKEN: 'secret',
        DISCORDINATOR_AUTH_MODE: 'bearer',
    },
};
const snapshot: PanelSnapshot = {
    documents: structuredClone(documents),
    originals: { operator: '', policy: '', environment: '' },
    paths: { operator: '', policy: '', environment: '' },
};
const models = { source: 'fixture', observedAt: '', note: '', defaultModel: { id: '', name: 'Default', efforts: ['high'] }, models: [] };
const observed: Observations = {
    live: { gateway: 'ready', events: { subscriptions: 0 }, operator: { mode: 'codex-local', appliedConfigAt: null } },
    runtime: true,
    active: { ...defaultOperatorConfig(), mode: 'codex-local', enabled: true },
    codex: models,
    claude: models,
    service: { available: true, installed: false, active: false },
    observedAt: '',
};
const key = (patch: Partial<Key> = {}): Key => ({
    ctrl: false,
    meta: false,
    escape: false,
    return: false,
    tab: false,
    shift: false,
    backspace: false,
    delete: false,
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    ...patch,
});

function store(): Store & { state: UiState } {
    const value = { state: initialState(snapshot, observed) } as Store & { state: UiState };
    value.get = () => value.state;
    value.set = (update) => (value.state = update(value.state));
    value.exit = () => undefined;
    return value;
}

function render(state: UiState, width: number, height: number) {
    const view = viewOf(state);
    const items = pageItems(state.page, view);
    return frame({
        view,
        page: state.page,
        focus: state.focus,
        items,
        selected: selectedIndex(state, items),
        scroll: state.scroll,
        ...(state.sheet ? { overlay: sheetLines(state.sheet, width) } : {}),
        width,
        height,
    }).lines;
}

function checkFrames(): void {
    const ui = store();
    for (const [width, height] of [
        [80, 23],
        [120, 39],
    ] as const)
        for (const page of pages) {
            ui.state = { ...ui.state, page: page.id };
            const lines = render(ui.state, width, height);
            assert.equal(lines.length, height, `${page.id} height`);
            for (const value of lines) assert.equal(lineWidth(value), width, `${page.id} line width at ${width}`);
        }
    const wizard = wizardFrame({ stage: 1, title: 'Who answers', body: ['x'], options: ['a', 'b'], selected: 0, tick: 0 }, 80, 23);
    assert.ok(wizard.every((value) => lineWidth(value) === 80));
}

function checkKeyboard(): void {
    const ui = store();
    handleKey(ui, '2', key());
    assert.equal(ui.state.page, 'assistant');
    handleKey(ui, '', key({ return: true }));
    assert.equal(ui.state.drafts.operator.mode, 'claude-session', 'Enter on the first card selects it');
    assert.equal(viewOf(ui.state).changes.length, 1);
    handleKey(ui, 's', key());
    assert.equal(ui.state.sheet?.kind, 'confirm', 'S opens the review');
    handleKey(ui, '', key({ escape: true }));
    assert.equal(ui.state.sheet, undefined);
    handleKey(ui, '/', key());
    for (const character of 'public domain') handleKey(ui, character, key());
    handleKey(ui, '', key({ return: true }));
    assert.equal(ui.state.page, 'apps', 'search jumps to the page that owns the setting');
    const editor = () => (ui.state.sheet?.kind === 'edit' ? ui.state.sheet : undefined);
    assert.equal(editor()?.input, 'bot.example.com', 'domain is edited without protocol');
    const type = (value: string) => {
        ui.state = { ...ui.state, sheet: { ...editor()!, input: '' } };
        for (const character of value) handleKey(ui, character, key());
        handleKey(ui, '', key({ return: true }));
    };
    type('https://new.example.com');
    assert.match(editor()?.error ?? '', /just the domain/, 'protocol is rejected with a visible error');
    type('new.example.com');
    assert.equal(editor(), undefined);
    assert.equal(ui.state.drafts.environment.DISCORDINATOR_RESOURCE_URL, 'https://new.example.com/mcp');
    handleKey(ui, '/', key());
    const search = () => (ui.state.sheet?.kind === 'search' ? ui.state.sheet : undefined);
    assert.equal(search()?.reachable.includes('environment.DISCORDINATOR_AUTH_MODE'), false);
    for (const character of 'mcp authentication') handleKey(ui, character, key());
    assert.equal(searchResults(search()!).length, 0, 'search only offers settings on a page');
    handleKey(ui, '', key({ escape: true }));
}

const text = (state: UiState) =>
    render(state, 120, 200)
        .map((value) => value.spans.map((item) => item.text).join(''))
        .join('\n');

function checkResponderPage(): void {
    const ui = store();
    const drafted = (operator: Record<string, unknown>): UiState => ({
        ...ui.state,
        page: 'assistant',
        drafts: { ...ui.state.drafts, operator: { ...ui.state.drafts.operator, ...operator } },
    });
    const chatgpt = text(drafted({ mode: 'chatgpt-events' }));
    for (const row of [
        'Public domain set',
        'Sign-in password set',
        'ChatGPT (web) connector added',
        'Wake-up events allowed',
        'ChatGPT connector guide',
    ])
        assert.ok(chatgpt.includes(row), `ChatGPT - Dot shows ${row}`);
    const manual = text(drafted({ mode: 'manual-mcp' }));
    assert.ok(
        manual.includes('http://127.0.0.1:8787/mcp') && manual.includes('https://bot.example.com/mcp'),
        'Another MCP app shows its addresses',
    );
    assert.ok(text(drafted({ mode: 'claude-session' })).includes('Opens in Claude Desktop when needed'));
    assert.ok(
        !text(drafted({ mode: 'claude-session', backgroundOnly: true })).includes('Claude Desktop when needed'),
        'hidden in the background',
    );
    const live = (appliedConfigAt: string | null) =>
        viewOf({ ...ui.state, observed: { ...observed, live: { ...observed.live!, operator: { mode: 'codex-local', appliedConfigAt } } } });
    assert.equal(savedDiffers(live(null)), true, 'a saved responder that is not applied yet is flagged');
    assert.equal(savedDiffers(live(observed.active.updatedAt)), false);
}

function checkMouse(): void {
    const ui = store();
    const click = (target: string) => {
        const map = hits(render(ui.state, 120, 39));
        const spot = map.find((item) => item.target === target);
        assert.ok(spot, `target ${target} is clickable`);
        handleMouse(ui, map, 0, spot.x0, spot.y);
    };
    click('page:discord');
    assert.equal(ui.state.page, 'discord');
    click('page:assistant');
    click('mode:chatgpt-events');
    assert.equal(ui.state.drafts.operator.mode, 'chatgpt-events', 'clicking a card selects it like Enter');
    click('save');
    assert.equal(ui.state.sheet?.kind, 'confirm');
    click('sheet:button:1');
    assert.equal(ui.state.sheet, undefined, 'Keep editing closes the review');
}

export function checkUi(): void {
    checkFrames();
    checkKeyboard();
    checkMouse();
    checkResponderPage();
}
