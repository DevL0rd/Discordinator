import { runFile, type Runner } from './run.js';

export async function openUrl(url: string, platform = process.platform, run: Runner = runFile): Promise<void> {
    if (platform === 'win32') await run('rundll32', ['url.dll,FileProtocolHandler', url]);
    else await run('xdg-open', [url]);
}

export async function handlesScheme(scheme: string, platform = process.platform, run: Runner = runFile): Promise<boolean> {
    if (platform === 'win32')
        return run('reg', ['query', `HKCR\\${scheme}`, '/v', 'URL Protocol']).then(
            () => true,
            () => false,
        );
    const handler = await run('xdg-mime', ['query', 'default', `x-scheme-handler/${scheme}`]).catch(() => ({ stdout: '' }));
    return handler.stdout.trim().length > 0;
}
