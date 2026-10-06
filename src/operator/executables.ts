import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';

async function forcesCodexHome(path: string): Promise<boolean> {
    const info = await stat(path);
    if (!info.isFile() || info.size > 65_536) return false;
    return /^\s*(export\s+)?CODEX_HOME=/m.test(await readFile(path, 'utf8'));
}

async function findExecutable(name: string, skip: (path: string) => Promise<boolean> = () => Promise.resolve(false)): Promise<string> {
    for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
        const candidate = join(directory, name);
        if (
            !(await access(candidate, constants.X_OK).then(
                () => true,
                () => false,
            ))
        )
            continue;
        if (!(await skip(candidate))) return candidate;
    }
    throw new Error(`${name === 'claude' ? 'Claude Code' : 'Codex'} is not installed or not on PATH`);
}

export const claudeExecutable = () => findExecutable('claude');
export const codexExecutable = () => findExecutable('codex', forcesCodexHome);
