import { readFile } from 'node:fs/promises';

export async function runtimePresent(): Promise<boolean> {
    try {
        const pid = Number((await readFile('.data/runtime.lock', 'utf8')).trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) return false;
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
