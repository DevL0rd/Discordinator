import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ProtocolError } from '@modelcontextprotocol/server';
import { Webhook } from 'standardwebhooks';
import { CallbackError, callbackUrl, type CallbackSender } from './https.js';

export interface Principal { id: string; expiresAt?: number }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function signedHeaders(id: string, body: string, subscription: { id: string; secret: string; previous?: { secret: string; until: number } }, now: number) {
  const signedAt = new Date(now);
  const signatures = [new Webhook(subscription.secret).sign(id, signedAt, body)];
  if (subscription.previous && subscription.previous.until > now) {
    signatures.push(new Webhook(subscription.previous.secret).sign(id, signedAt, body));
  }
  return { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(Math.floor(now / 1000)),
    'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': subscription.id };
}

export class Verifier {
  private cache = new Map<string, number>();
  constructor(readonly sender: CallbackSender, readonly now = Date.now) {}
  async verify(owner: string, subscription: { id: string; url: string; secret: string }, cancellation = new AbortController().signal): Promise<void> {
    const key = hash([owner, subscription.url, subscription.secret]);
    try {
      cancellation.throwIfAborted();
      callbackUrl(subscription.url);
      for (const [id, expires] of this.cache) if (expires <= this.now()) this.cache.delete(id);
      if (this.cache.has(key)) return;
      const challenge = randomBytes(32).toString('base64url');
      const body = JSON.stringify({ type: 'verification', challenge });
      const id = `msg_verification_${randomBytes(16).toString('hex')}`;
      const response = await this.sender(subscription.url, body, signedHeaders(id, body, subscription, this.now()), AbortSignal.any([cancellation, AbortSignal.timeout(10_000)]));
      if (response.status < 200 || response.status >= 300) throw new CallbackError('challenge_failed');
      if (!equalChallenge(response.body, challenge)) throw new CallbackError('challenge_failed');
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, this.now() + 5 * 60_000);
    } catch (error) {
      throw verificationError(error);
    }
  }
}

function equalChallenge(body: string, expected: string): boolean {
  const parsed = JSON.parse(body) as { challenge?: unknown };
  if (typeof parsed.challenge !== 'string') return false;
  const actual = Buffer.from(parsed.challenge);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function verificationError(error: unknown): ProtocolError {
  const reason = error instanceof CallbackError ? error.reason : 'challenge_failed';
  return new ProtocolError(-32015, 'CallbackEndpointError', { reason });
}
