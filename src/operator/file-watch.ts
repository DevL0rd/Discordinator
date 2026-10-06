import { watch } from 'node:fs';
import { access } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

function settledWatch(directory: string, matches: (file: string | null) => boolean, onChange: () => void, settleMs: number): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(directory, { persistent: false }, (_event, file) => {
        if (!matches(file)) return;
        clearTimeout(timer);
        timer = setTimeout(onChange, settleMs);
    });
    watcher.on('error', () => undefined);
    return () => {
        clearTimeout(timer);
        watcher.close();
    };
}

export function watchFile(path: string, onChange: () => void, settleMs = 50): () => void {
    const name = basename(path);
    return settledWatch(dirname(path), (file) => !file || file === name, onChange, settleMs);
}

export function watchDirectory(directory: string, onChange: () => void, settleMs = 50): () => void {
    return settledWatch(directory, () => true, onChange, settleMs);
}

export async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
    const exists = () =>
        access(path).then(
            () => true,
            () => false,
        );
    return new Promise((resolve) => {
        let settled = false;
        const finish = (found: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stop();
            resolve(found);
        };
        const check = () => void exists().then((found) => found && finish(true));
        const stop = watchFile(path, check);
        const timer = setTimeout(() => finish(false), timeoutMs);
        check();
    });
}
