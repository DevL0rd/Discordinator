import { lookup } from 'node:dns/promises';
import type { RequestOptions } from 'node:https';
import { request } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export interface CallbackResponse { status: number; body: string }
export type CallbackSender = (url: string, body: string, headers: Record<string, string>, signal: AbortSignal) => Promise<CallbackResponse>;
export class CallbackError extends Error {
  constructor(readonly reason: string) { super('Callback endpoint rejected'); }
}
export interface Address { address: string; family: number }
export type Resolver = (host: string) => Promise<Address[]>;

export function callbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new CallbackError('invalid_url');
  }
  return url;
}

export function publicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== 'unicast') return false;
  if (parsed.kind() === 'ipv6') return parsed.match(ipaddr.parse('2000::'), 3);
  return true;
}

export async function resolveCallback(value: string, resolver: Resolver, signal: AbortSignal): Promise<{ url: URL; address: Address }> {
  const url = callbackUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(resolver(host), signal);
  if (!addresses.length || addresses.length > 16 || addresses.some(item => !publicAddress(item.address))) {
    throw new CallbackError('non_public_address');
  }
  signal.throwIfAborted();
  return { url, address: addresses[0]! };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CallbackError('timeout'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** New connection per attempt: DNS validated once, pinned lookup, normal hostname TLS verification. */
export function httpsSender(resolver: Resolver = host => lookup(host, { all: true, verbatim: true })): CallbackSender {
  return async (value, body, headers, signal) => {
    const { url, address } = await resolveCallback(value, resolver, signal);
    return new Promise((resolve, reject) => {
      const outgoing = request(url, connectionOptions(url, address, headers, signal), incoming => collect(incoming, resolve, reject));
      outgoing.on('error', () => reject(new CallbackError(signal.aborted ? 'timeout' : 'network_error')));
      outgoing.end(body);
    });
  };
}

function collect(incoming: import('node:http').IncomingMessage, resolve: (result: CallbackResponse) => void, reject: (error: Error) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  incoming.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 8192) { incoming.destroy(); reject(new CallbackError('response_too_large')); return; }
    chunks.push(chunk);
  });
  incoming.on('error', () => reject(new CallbackError('network_error')));
  incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
}

export function connectionOptions(url: URL, address: Address, headers: Record<string, string>, signal: AbortSignal): RequestOptions {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return { method: 'POST', agent: false, signal, headers, servername: isIP(host) ? undefined : host,
    lookup: (_host, options, callback) => {
      if (options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    } };
}
