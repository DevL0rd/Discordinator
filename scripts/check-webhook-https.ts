import assert from 'node:assert/strict';
import { CallbackError, callbackUrl, connectionOptions, httpsSender, publicAddress, resolveCallback } from '../src/events/https.js';
import { downloader } from '../src/media/download.js';
import { loopbackServer } from './loopback-server.js';

const publicResolver = () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]);
const reason = (expected: string) => (error: unknown) => error instanceof CallbackError && error.reason === expected;

function checkAddressRules(): void {
    assert.equal(callbackUrl('https://receiver.example:443/hook').port, '', 'The default HTTPS port is accepted');
    assert.throws(() => callbackUrl('https://receiver.example:8443/hook'), reason('invalid_url'));
    assert.throws(() => callbackUrl('https://receiver.example/hook#fragment'), reason('invalid_url'));
    assert.equal(publicAddress('not-an-address'), false);
    const signal = AbortSignal.timeout(10_000);
    const ipv4 = connectionOptions(new URL('https://8.8.8.8/hook'), { address: '8.8.8.8', family: 4 }, {}, signal);
    assert.equal(ipv4.servername, undefined, 'IP literals skip SNI');
    const answers: unknown[] = [];
    ipv4.lookup!('8.8.8.8', { all: true }, (_error, address) => answers.push(address));
    assert.deepEqual(answers, [[{ address: '8.8.8.8', family: 4 }]], 'Pinned lookups answer list requests too');
}

async function checkLiteralHosts(): Promise<void> {
    const signal = AbortSignal.timeout(10_000);
    const never = () => Promise.reject(new Error('IP literals are never resolved'));
    const ipv6 = await resolveCallback('https://[2606:4700::1111]/hook', never, signal);
    assert.deepEqual(ipv6.address, { address: '2606:4700::1111', family: 6 });
    await assert.rejects(resolveCallback('https://[::1]/hook', never, signal), reason('non_public_address'));
    const crowded = () => Promise.resolve(Array.from({ length: 17 }, () => ({ address: '8.8.8.8', family: 4 })));
    await assert.rejects(resolveCallback('https://receiver.example/hook', crowded, signal), reason('non_public_address'));
    await assert.rejects(
        resolveCallback('https://receiver.example/hook', () => Promise.resolve([]), signal),
        reason('non_public_address'),
    );
    await assert.rejects(
        httpsSender()('https://localhost/hook', '{}', {}, signal),
        reason('non_public_address'),
        'The system resolver is used and loopback answers are refused',
    );
    await assert.rejects(downloader()(new URL('https://localhost/file'), 1), reason('non_public_address'));
}

async function checkSender(server: Awaited<ReturnType<typeof loopbackServer>>, stall: { abort: () => void }): Promise<void> {
    const send = httpsSender(publicResolver, server.transport);
    const signal = () => AbortSignal.timeout(10_000);
    const delivered = await send('https://receiver.example/ok', '{"hello":true}', { 'webhook-id': 'evt_fixture' }, signal());
    assert.deepEqual(delivered, { status: 202, body: 'accepted' });
    const request = server.received.find((item) => item.path === '/ok')!;
    assert.equal(request.method, 'POST');
    assert.equal(request.body, '{"hello":true}');
    assert.equal(request.headers['webhook-id'], 'evt_fixture');
    assert.deepEqual(server.pinned[0], {
        url: 'https://receiver.example/ok',
        address: [{ address: '8.8.8.8', family: 4 }],
        servername: 'receiver.example',
    });
    await assert.rejects(send('https://receiver.example/large', '{}', {}, signal()), reason('response_too_large'));
    await assert.rejects(send('https://receiver.example/hangup', '{}', {}, signal()), reason('network_error'));
    await assert.rejects(send('https://receiver.example/partial', '{}', {}, signal()), reason('network_error'));
    const controller = new AbortController();
    stall.abort = () => controller.abort();
    await assert.rejects(send('https://receiver.example/stall', '{}', {}, controller.signal), reason('timeout'));
}

async function checkDownloads(server: Awaited<ReturnType<typeof loopbackServer>>): Promise<void> {
    const download = downloader(publicResolver, server.transport);
    const file = await download(new URL('https://cdn.discordapp.com/file'), 5);
    assert.equal(file.toString(), 'bytes');
    const fetched = server.received.find((item) => item.path === '/file')!;
    assert.equal(fetched.method, 'GET');
    assert.equal(fetched.headers['accept-encoding'], 'identity');
    await assert.rejects(download(new URL('https://cdn.discordapp.com/hangup'), 5), /Attachment download failed/);
}

export async function checkWebhookHttps(): Promise<void> {
    checkAddressRules();
    await checkLiteralHosts();
    const stall = { abort: () => undefined as void };
    const server = await loopbackServer({
        '/ok': (response) => response.writeHead(202).end('accepted'),
        '/large': (response) => response.writeHead(200).end('x'.repeat(9000)),
        '/hangup': (response) => response.socket?.destroy(),
        '/partial': (response) => {
            response.writeHead(200);
            response.write('partial', () => response.socket?.destroy());
        },
        '/stall': () => stall.abort(),
        '/file': (response) => response.writeHead(200).end('bytes'),
    });
    try {
        await checkSender(server, stall);
        await checkDownloads(server);
    } finally {
        await server.close();
    }
}
