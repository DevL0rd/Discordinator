import { stdin, stdout } from 'node:process';
import { mkdir } from 'node:fs/promises';
import { useState } from 'react';
import { render } from 'ink';
import { h } from './ui/render.js';
import { Dashboard } from './ui/app.js';
import { observations } from './ui/observe.js';
import { readPanel } from './panel-store.js';
import { Onboarding } from './onboarding.js';
import { needsOnboarding } from './onboarding-store.js';
import { migrateEnvironment } from '../core/env-migration.js';

await migrateEnvironment();
await mkdir('.data', { recursive: true, mode: 0o700 });
const firstRun = await needsOnboarding(process.env);
let snapshot = await readPanel();
let observed = await observations();

function Setup() {
    const [ready, setReady] = useState(!firstRun);
    if (ready) return h(Dashboard, { initial: snapshot, observed });
    return h(Onboarding, {
        onComplete: () => {
            void Promise.all([readPanel(), observations()]).then(([nextSnapshot, nextObserved]) => {
                snapshot = nextSnapshot;
                observed = nextObserved;
                setReady(true);
            });
        },
    });
}

if (!stdin.isTTY || !stdout.isTTY) {
    console.log(JSON.stringify({ saved: snapshot.documents.operator, live: observed.live, service: observed.service }, null, 2));
} else {
    stdout.write('\x1b[?1049h\x1b[?25l');
    try {
        const app = render(h(Setup), { exitOnCtrlC: false, patchConsole: true, incrementalRendering: true });
        await app.waitUntilExit();
    } finally {
        stdout.write('\x1b[?25h\x1b[?1049l');
    }
}
