import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { replaceFile } from './replace-file.js';
import { parseEnv } from 'node:util';

const legacy = /^DOTBOT_([A-Z0-9_]+)=/gm;

export async function migrateEnvironment(path = '.env', target: NodeJS.ProcessEnv = process.env): Promise<number> {
    const original = await readFile(path, 'utf8').catch(() => '');
    const present = new Set(Object.keys(parseEnv(original)));
    let count = 0;
    const migrated = original.replace(legacy, (match, key: string) => {
        if (present.has(`DISCORDINATOR_${key}`)) return match;
        count++;
        return `DISCORDINATOR_${key}=`;
    });
    if (!count) return 0;
    await mkdir('.data/setup-backups', { recursive: true, mode: 0o700 });
    await writeFile(`.data/setup-backups/${Date.now()}-environment-rename.json`, JSON.stringify({ path, original }), { mode: 0o600 });
    await writeFile(`${path}.rename.tmp`, migrated, { mode: 0o600, flush: true });
    await replaceFile(`${path}.rename.tmp`, path);
    for (const [key, value] of Object.entries(parseEnv(migrated))) if (key.startsWith('DISCORDINATOR_')) target[key] ??= value;
    return count;
}
