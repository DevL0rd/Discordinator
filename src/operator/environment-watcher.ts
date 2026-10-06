import { readFile } from 'node:fs/promises';
import { watchFile } from './file-watch.js';

const read = (path: string) => readFile(path, 'utf8').catch(() => '');

export function restartOnEnvironmentChange(path: string, whenIdle: () => Promise<void>, restart: () => Promise<void>): () => void {
    if (!process.env.INVOCATION_ID) return () => undefined;
    const loaded = read(path);
    let restarting = false;
    return watchFile(path, () => {
        void Promise.all([loaded, read(path)]).then(async ([before, now]) => {
            if (restarting || before === now) return;
            restarting = true;
            console.error('Settings in .env changed; restarting to apply them once idle');
            await whenIdle();
            await restart();
        });
    });
}
