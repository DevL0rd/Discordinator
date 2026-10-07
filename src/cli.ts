import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { appHome, installRecordPath } from './operator/app-home.js';
import { applyUpdate, installApp, localShell, uninstallApp } from './operator/self-install.js';

const usage = `Usage: discordinator [command]

  (no command)        Open the settings app
  install             Install or reinstall Discordinator from this folder, with its background service
  update              Update the installed copy from GitHub and restart the service
  uninstall [--purge] Remove Discordinator; --purge also deletes your settings
  help                Show this help
`;

function useInstalledCopy(): void {
    const home = appHome();
    if (resolve(process.cwd()) !== resolve(home) && existsSync(installRecordPath(home))) process.chdir(home);
    if (existsSync('.env')) process.loadEnvFile('.env');
}

async function main(args: string[]): Promise<void> {
    const [command, ...rest] = args;
    const print = (lines: string[] | string) => console.log([lines].flat().join('\n'));
    if (command === 'install') return print(await installApp(localShell(true)));
    if (command === 'update') return print(await applyUpdate(localShell(true)));
    if (command === 'uninstall') return print(await uninstallApp(localShell(true), rest.includes('--purge')));
    if (command === 'help' || command === '--help' || command === '-h') return print(usage);
    if (command) throw new Error(`Unknown command: ${command}\n\n${usage}`);
    useInstalledCopy();
    const { runSetup } = await import('./operator/setup-app.js');
    await runSetup();
}

try {
    await main(process.argv.slice(2));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
