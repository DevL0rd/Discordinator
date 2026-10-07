import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, sep } from 'node:path';
import type { OutFile } from '../core/sender.js';
import { inspectFile } from './formats.js';

/** A Discord-safe version of a file name, keeping its extension. */
export function safeFileName(name: string): string {
    const cleaned = name
        .replace(/[^\p{L}\p{N}_. -]/gu, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/^[^\p{L}\p{N}_]+/u, '');
    return cleaned.slice(-100);
}

/** Reads a local file for sending. Only files inside the allowed folders (the temp folder by default) can be read; symlinks are resolved first. */
export async function readLocalFile(path: string, maxBytes: number, roots: string[] = [tmpdir()]): Promise<OutFile> {
    const real = await realpath(path).catch(() => {
        throw new Error(`File not found: ${basename(path)}`);
    });
    const allowed = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
    if (!allowed.some((root) => real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)))
        throw new Error(`Only files inside ${roots.join(' or ')} can be sent by path`);
    const info = await stat(real);
    if (!info.isFile()) throw new Error('Only regular files can be sent');
    if (info.size > maxBytes) throw new Error(`${basename(real)} is larger than the ${Math.round(maxBytes / 1024)} KiB file limit`);
    const data = await readFile(real);
    const name = safeFileName(basename(real));
    const contentType = await inspectFile(data, name);
    return { data, name, contentType, sha256: createHash('sha256').update(data).digest('hex') };
}
