import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function openUrl(url: string): Promise<void> {
    if (process.platform === 'win32') await exec('rundll32', ['url.dll,FileProtocolHandler', url]);
    else await exec('xdg-open', [url]);
}

export async function handlesScheme(scheme: string): Promise<boolean> {
    if (process.platform === 'win32')
        return exec('reg', ['query', `HKCR\\${scheme}`, '/v', 'URL Protocol']).then(
            () => true,
            () => false,
        );
    const handler = await exec('xdg-mime', ['query', 'default', `x-scheme-handler/${scheme}`]).catch(() => ({ stdout: '' }));
    return handler.stdout.trim().length > 0;
}
