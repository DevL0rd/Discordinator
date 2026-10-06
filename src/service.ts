import { spawn } from 'node:child_process';
import { appendFileSync, renameSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { serviceLogFile, supervisorPidFile } from './operator/windows-service.js';

const logLimit = 10 * 1024 * 1024;
const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

let written = (await stat(serviceLogFile).catch(() => undefined))?.size ?? 0;

function log(chunk: Buffer): void {
    if (written + chunk.length > logLimit) {
        renameSync(serviceLogFile, `${serviceLogFile}.old`);
        written = 0;
    }
    appendFileSync(serviceLogFile, chunk, { mode: 0o600 });
    written += chunk.length;
}

await mkdir('.data', { recursive: true, mode: 0o700 });
const running = Number(await readFile(supervisorPidFile, 'utf8').catch(() => ''));
if (running && running !== process.pid && alive(running)) process.exit(0);
await writeFile(supervisorPidFile, String(process.pid), { mode: 0o600 });

function run(): void {
    const child = spawn(process.execPath, ['--env-file=.env', 'dist/src/main.js'], {
        env: { ...process.env, DISCORDINATOR_SERVICE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    child.stdout.on('data', log);
    child.stderr.on('data', log);
    child.once('exit', (code) => {
        if (code === 0) void rm(supervisorPidFile, { force: true }).then(() => process.exit(0));
        else setTimeout(run, 5000);
    });
}

run();
