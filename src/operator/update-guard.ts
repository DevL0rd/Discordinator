import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const stateDirectory = (home: string, env: NodeJS.ProcessEnv = process.env) =>
    join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'discordinator');

const failurePath = (home: string) => join(stateDirectory(home), 'update-failed');
const lockPath = (home: string) => join(stateDirectory(home), 'update.lock');

export async function failedInputs(home: string): Promise<string | undefined> {
    return readFile(failurePath(home), 'utf8').then(
        (text) => text.trim(),
        () => undefined,
    );
}

export async function recordFailure(home: string, inputs: string): Promise<void> {
    await mkdir(stateDirectory(home), { recursive: true, mode: 0o700 });
    await writeFile(failurePath(home), `${inputs}\n`, { mode: 0o600 });
}

export async function clearFailure(home: string): Promise<void> {
    await rm(failurePath(home), { force: true });
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
};

async function takeLock(home: string): Promise<boolean> {
    await mkdir(stateDirectory(home), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await writeFile(lockPath(home), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const holder = Number(await readFile(lockPath(home), 'utf8').catch(() => ''));
            if (holder && alive(holder)) return false;
            await rm(lockPath(home), { force: true });
        }
    }
    return false;
}

export async function withUpdateLock<T>(home: string, work: () => Promise<T>): Promise<T | undefined> {
    if (!(await takeLock(home))) return undefined;
    try {
        return await work();
    } finally {
        await rm(lockPath(home), { force: true });
    }
}
