import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { restartRequestFile } from './environment-watcher.js';

const exec = promisify(execFile);
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const entry = 'Discordinator';
export const serviceLogFile = '.data/service.log';
export const supervisorPidFile = '.data/service.pid';

const launcherPath = (root: string) => join(root, '.data', 'service-launch.js');

export function launcherScript(root: string, node: string): string {
    const command = `"${node}" "${join(root, 'dist', 'src', 'service.js')}"`;
    return [
        'var shell = new ActiveXObject("WScript.Shell");',
        `shell.CurrentDirectory = ${JSON.stringify(root)};`,
        `shell.Run(${JSON.stringify(command)}, 0, false);`,
        '',
    ].join('\r\n');
}

export async function installWindowsService(root: string, node: string): Promise<void> {
    await mkdir(join(root, '.data'), { recursive: true, mode: 0o700 });
    await writeFile(launcherPath(root), launcherScript(root, node), { mode: 0o600 });
    await exec('reg', ['add', runKey, '/v', entry, '/t', 'REG_SZ', '/d', `wscript.exe //B //Nologo "${launcherPath(root)}"`, '/f']);
}

export async function startWindowsService(root: string): Promise<void> {
    await exec('wscript.exe', ['//B', '//Nologo', launcherPath(root)]);
}

export async function supervisorRunning(): Promise<boolean> {
    const pid = Number(await readFile(supervisorPidFile, 'utf8').catch(() => ''));
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export async function windowsServiceInstalled(): Promise<boolean> {
    return exec('reg', ['query', runKey, '/v', entry]).then(
        () => true,
        () => false,
    );
}

export async function requestRestart(): Promise<void> {
    await mkdir('.data', { recursive: true, mode: 0o700 });
    await writeFile(restartRequestFile, new Date().toISOString(), { mode: 0o600 });
}
