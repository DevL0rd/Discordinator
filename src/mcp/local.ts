import type { IncomingMessage } from 'node:http';
import type { Config } from '../core/config.js';

export function localTunnelRequest(request: IncomingMessage, config: Config): boolean {
    if (request.socket.remoteAddress !== '127.0.0.1' || request.socket.localAddress !== '127.0.0.1') return false;
    const hosts = [`127.0.0.1:${config.DOTBOT_PORT}`, `localhost:${config.DOTBOT_PORT}`];
    if (!hosts.includes(request.headers.host ?? '') || request.headers.origin !== undefined) return false;
    return !Object.keys(request.headers).some(
        (name) =>
            name === 'forwarded' ||
            name === 'via' ||
            name.startsWith('x-forwarded-') ||
            name === 'x-real-ip' ||
            name === 'cf-connecting-ip',
    );
}
