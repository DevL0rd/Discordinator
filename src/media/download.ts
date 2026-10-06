import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { connectionOptions, resolveCallback, type Resolver, type Transport } from '../events/https.js';

export type Downloader = (url: URL, expected: number) => Promise<Buffer>;

export function attachmentUrl(value: string, channelId: string, attachmentId: string): URL {
    const url = new URL(value);
    assertCdn(url);
    const prefix = `/attachments/${channelId}/${attachmentId}/`;
    if (!url.pathname.startsWith(prefix) || url.pathname.slice(prefix.length).includes('/'))
        throw new Error('Attachment path does not match its source');
    const filename = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!filename || /[/\\]/.test(filename) || filename === '..') throw new Error('Invalid CDN filename');
    return url;
}

function assertCdn(url: URL): void {
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.discordapp.com' || url.port || url.username || url.password || url.hash) {
        throw new Error('Attachment CDN is not approved');
    }
}

export function downloader(
    resolver: Resolver = (host) => lookup(host, { all: true, verbatim: true }),
    transport: Transport = request,
): Downloader {
    return async (url, expected) => {
        const signal = AbortSignal.timeout(10_000);
        const pinned = await resolveCallback(url.href, resolver, signal);
        return new Promise((resolve, reject) => {
            const options = connectionOptions(url, pinned.address, { 'Accept-Encoding': 'identity' }, signal);
            const outgoing = transport(url, { ...options, method: 'GET' }, (incoming) => collect(incoming, expected, resolve, reject));
            outgoing.on('error', () => reject(new Error('Attachment download failed')));
            outgoing.end();
        });
    };
}

export function collect(
    incoming: IncomingMessage,
    expected: number,
    resolve: (data: Buffer) => void,
    reject: (error: Error) => void,
): void {
    if (incoming.statusCode !== 200 || incoming.headers['content-encoding']) {
        incoming.destroy();
        reject(new Error('Attachment response rejected; redirects are forbidden'));
        return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > expected) {
            incoming.destroy();
            reject(new Error('Attachment exceeds declared size'));
            return;
        }
        chunks.push(chunk);
    });
    incoming.on('error', () => reject(new Error('Attachment stream failed')));
    incoming.on('end', () => {
        if (size !== expected) reject(new Error('Attachment size changed'));
        else resolve(Buffer.concat(chunks));
    });
}
