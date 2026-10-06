import assert from 'node:assert/strict';
import { handleMouse, sgrMouse } from '../src/operator/ui/mouse.js';
import { navWidth } from '../src/operator/ui/frame.js';
import { setting } from '../src/operator/ui/items.js';
import { selectedIndex } from '../src/operator/ui/state.js';
import type { Hit } from '../src/operator/ui/canvas.js';
import type { Sheet } from '../src/operator/ui/sheets.js';
import { sheetOf, uiStore, type TestStore } from './ui-fixtures.js';

const at = (target: string): Hit[] => [{ y: 3, x0: 30, x1: 40, target }];
const click = (ui: TestStore, target: string, code = 0) => handleMouse(ui, at(target), code, 35, 3);
const choices = ['messages.read', 'messages.write', 'reactions.add'];
const multi = (): Sheet => ({ kind: 'multi', field: { ...setting('policy.scopes'), choices }, label: 'Scopes', chosen: [], index: 1 });
const edit = (options: string[] = ['channel', 'server']): Sheet => ({
    kind: 'edit',
    field: setting('policy.context.reach'),
    label: 'Reach',
    input: 'channel',
    options,
    labels: {},
});

function checkWheel(): void {
    const ui = uiStore(undefined, { page: 'memory' });
    handleMouse(ui, [], 65, navWidth + 1, 5);
    assert.equal(selectedIndex(ui.state), 2, 'scrolling down over the page moves the cursor');
    handleMouse(ui, [], 64, navWidth + 1, 5);
    assert.equal(selectedIndex(ui.state), 1, 'scrolling up moves it back');
    handleMouse(ui, [], 65, navWidth, 5);
    assert.equal(ui.state.page, 'system', 'scrolling over the page list changes page');
    handleMouse(ui, [], 64, 1, 5);
    assert.equal(ui.state.page, 'memory');
    ui.state = { ...ui.state, sheet: multi() };
    handleMouse(ui, [], 65, 50, 5);
    handleMouse(ui, [], 65, 50, 5);
    assert.equal(sheetOf(ui, 'multi').index, 2, 'scrolling a checklist stops at the last choice');
    for (let step = 0; step < 4; step++) handleMouse(ui, [], 64, 50, 5);
    assert.equal(sheetOf(ui, 'multi').index, 0, 'and at the first');
    ui.state = { ...ui.state, sheet: edit() };
    const before = ui.state;
    handleMouse(ui, [], 65, 50, 5);
    assert.equal(ui.state, before, 'other sheets ignore the wheel');
}

function checkIgnored(): void {
    const ui = uiStore();
    const before = ui.state;
    click(ui, 'help', 2);
    click(ui, 'help', 32);
    click(ui, 'help', 1);
    handleMouse(ui, at('help'), 0, 10, 3);
    click(ui, 'page:nowhere');
    click(ui, 'brand');
    assert.equal(ui.state, before, 'other buttons, drags, misses and plain text do nothing');
    const busy = uiStore(undefined, { busy: 'Saving…' });
    click(busy, 'help');
    handleMouse(busy, [], 65, 50, 5);
    assert.equal(busy.state.sheet, undefined, 'the mouse is ignored while busy');
    assert.equal(busy.state.scroll, 0);
}

function checkPageClicks(): void {
    const ui = uiStore();
    click(ui, 'help');
    assert.equal(ui.state.sheet?.kind, 'help', 'the ? button opens help');
    click(ui, 'nothing:here');
    assert.equal(ui.state.sheet?.kind, 'help', 'clicks outside a sheet target are ignored');
    click(ui, 'sheet:button:0');
    assert.equal(ui.state.sheet, undefined, 'any help button closes it');
    click(ui, 'page:memory');
    assert.deepEqual([ui.state.page, ui.state.focus], ['memory', 'nav']);
    click(ui, 'policy.context.capture');
    assert.deepEqual([ui.state.focus, ui.state.cursor.memory], ['content', 2], 'clicking a row selects it');
    assert.equal(sheetOf(ui, 'edit').field.id, 'policy.context.capture', 'and opens it');
    click(ui, 'sheet:button:1');
    click(ui, 'save');
    assert.deepEqual(ui.state.toast, { text: 'Nothing to save.', tone: 'idle' }, 'the unsaved badge opens the review');
}

function checkEditClicks(): void {
    const ui = uiStore(undefined, { sheet: edit() });
    click(ui, 'sheet:option:1');
    assert.equal(sheetOf(ui, 'edit').input, 'server', 'clicking an option picks it');
    click(ui, 'sheet:option:7');
    assert.equal(sheetOf(ui, 'edit').input, 'server', 'a missing option is ignored');
    click(ui, 'sheet:other:0');
    assert.equal(sheetOf(ui, 'edit').input, 'server');
    click(ui, 'sheet:button:0');
    assert.equal(ui.state.sheet, undefined, 'Done commits the edit');
    assert.equal((ui.state.drafts.policy.context as { reach: string }).reach, 'server');
    ui.state = { ...ui.state, sheet: edit([]) };
    click(ui, 'sheet:button:1');
    assert.equal(ui.state.sheet, undefined, 'Cancel closes the editor');
}

function checkMultiClicks(): void {
    const ui = uiStore(undefined, { sheet: multi() });
    click(ui, 'sheet:option:2');
    assert.deepEqual([sheetOf(ui, 'multi').chosen, sheetOf(ui, 'multi').index], [['reactions.add'], 2], 'clicking a choice toggles it');
    click(ui, 'sheet:option:9');
    assert.deepEqual(sheetOf(ui, 'multi').chosen, ['reactions.add'], 'a missing choice is ignored');
    click(ui, 'sheet:option:0');
    click(ui, 'sheet:button:0');
    assert.equal(ui.state.sheet, undefined);
    assert.deepEqual(ui.state.drafts.policy.scopes, ['messages.read', 'reactions.add'], 'Done stages the choices');
}

function checkSearchClicks(): void {
    const ui = uiStore();
    const search = (input: string): Sheet => ({
        kind: 'search',
        input,
        index: 0,
        reachable: ['policy.media.enabled', 'operator.workspace'],
    });
    ui.state = { ...ui.state, sheet: search('media') };
    click(ui, 'sheet:option:4');
    assert.equal(sheetOf(ui, 'search').input, 'media', 'a missing result is ignored');
    click(ui, 'sheet:option:0');
    assert.equal(ui.state.page, 'memory', 'clicking a result jumps to it');
    ui.state = { ...ui.state, sheet: search('') };
    click(ui, 'sheet:button:0');
    assert.equal(ui.state.sheet, undefined, 'search buttons close it');
}

function checkConfirmClicks(): void {
    const ui = uiStore();
    const pressed: number[] = [];
    const buttons = [0, 1, 2].map((index) => ({ label: `B${index}`, tone: 'info' as const, run: () => void pressed.push(index) }));
    ui.state = { ...ui.state, sheet: { kind: 'confirm', title: 'Pick', body: [], buttons, index: 0 } };
    click(ui, 'sheet:button:2');
    click(ui, 'sheet:button:1');
    click(ui, 'sheet:button:5');
    assert.deepEqual(pressed, [2, 1], 'confirm buttons run their action');
}

function checkSequence(): void {
    const escape = String.fromCharCode(27);
    const found = [...`${escape}[<0;12;7M${escape}[<64;3;4Mjunk${escape}[<0;1;1m`.matchAll(sgrMouse)].map((match) => match.slice(1, 4));
    assert.deepEqual(
        found,
        [
            ['0', '12', '7'],
            ['64', '3', '4'],
        ],
        'mouse presses are parsed and releases skipped',
    );
}

export function checkUiMouse(): void {
    checkWheel();
    checkIgnored();
    checkPageClicks();
    checkEditClicks();
    checkMultiClicks();
    checkSearchClicks();
    checkConfirmClicks();
    checkSequence();
}
