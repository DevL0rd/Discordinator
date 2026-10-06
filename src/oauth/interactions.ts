import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import argon2 from 'argon2';
import type Provider from 'oidc-provider';
import type { Owner } from './provision.js';
import { boundedBody, interactionPage, oauthJson } from './forms.js';
import type { OAuthStore } from './storage.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

export async function budget(store: OAuthStore, name: string, limit: number, duration: number): Promise<boolean> {
    let allowed = false;
    await store.mutate((records) => {
        const key = `Budget:${name}`;
        const times = ((records[key]?.payload.extra?.times as number[] | undefined) ?? []).filter((time) => time > Date.now() - duration);
        allowed = times.length < limit;
        if (allowed) times.push(Date.now());
        records[key] = { payload: { extra: { times } }, expires: Date.now() + duration };
    });
    return allowed;
}

async function formToken(store: OAuthStore, uid: string, prompt: string): Promise<string> {
    const csrf = randomBytes(32).toString('base64url');
    await store.adapter('BrowserForm').upsert(uid, { extra: { csrf, prompt } }, 600);
    return csrf;
}

async function consumeForm(store: OAuthStore, uid: string, prompt: string, csrf: string): Promise<boolean> {
    let valid = false;
    await store.mutate((records) => {
        const key = `BrowserForm:${uid}`;
        const extra = records[key]?.payload.extra;
        valid = extra?.prompt === prompt && typeof extra.csrf === 'string' && timingSafeEqual(digest(extra.csrf), digest(csrf));
        if (valid) delete records[key];
    });
    return valid;
}

export class OwnerInteractions {
    constructor(
        readonly provider: Provider,
        public owner: Owner,
        readonly store: OAuthStore,
        readonly resource: string,
    ) {}

    async handle(request: IncomingMessage, response: ServerResponse, uid: string): Promise<void> {
        const details = await this.provider.interactionDetails(request, response);
        console.error(
            `OAuth interaction ${JSON.stringify({
                method: request.method,
                prompt: details.prompt.name,
                detailKeys: Object.keys(details.prompt.details).sort(),
            })}`,
        );
        if (details.uid !== uid || !['login', 'consent'].includes(details.prompt.name)) {
            return oauthJson(response, 400, { error: 'Invalid interaction' });
        }
        if (request.method === 'GET') {
            const csrf = await formToken(this.store, uid, details.prompt.name);
            return interactionPage(
                response,
                details.prompt.name,
                csrf,
                String(details.params.client_id),
                String(details.params.redirect_uri),
            );
        }
        return this.submit(request, response, details);
    }

    private async submit(
        request: IncomingMessage,
        response: ServerResponse,
        details: Awaited<ReturnType<Provider['interactionDetails']>>,
    ): Promise<void> {
        if (request.method !== 'POST') return oauthJson(response, 405, { error: 'Method denied' });
        if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
            return oauthJson(response, 415, { error: 'Form required' });
        const form = new URLSearchParams(await boundedBody(request));
        if (
            [...form.keys()].length !== new Set(form.keys()).size ||
            !(await consumeForm(this.store, details.uid, details.prompt.name, form.get('csrf') ?? ''))
        ) {
            return oauthJson(response, 403, { error: 'Invalid CSRF token' });
        }
        if (form.get('action') === 'deny') {
            return this.provider.interactionFinished(
                request,
                response,
                { error: 'access_denied', error_description: 'Owner denied authorization' },
                { mergeWithLastSubmission: false },
            );
        }
        if (details.prompt.name === 'login') return this.login(request, response, form);
        await this.consent(request, response, details, form);
    }

    private async consent(
        request: IncomingMessage,
        response: ServerResponse,
        details: Awaited<ReturnType<Provider['interactionDetails']>>,
        form: URLSearchParams,
    ): Promise<void> {
        if (form.get('action') !== 'allow' || details.session?.accountId !== this.owner.subject) {
            return oauthJson(response, 403, { error: 'Owner consent required' });
        }
        const grant = new this.provider.Grant({ accountId: this.owner.subject, clientId: String(details.params.client_id) });
        grant.addOIDCScope('openid discordinator:control');
        grant.addResourceScope(this.resource, 'discordinator:control');
        const grantId = await grant.save();
        await this.provider.interactionFinished(request, response, { consent: { grantId } }, { mergeWithLastSubmission: true });
        console.error(
            `OAuth consent finished ${JSON.stringify({
                status: response.statusCode,
                location: safeLocation(response.getHeader('location')),
            })}`,
        );
    }

    private async login(request: IncomingMessage, response: ServerResponse, form: URLSearchParams): Promise<void> {
        if (!(await budget(this.store, 'login', 5, 15 * 60_000))) {
            response.setHeader('Retry-After', '900');
            return oauthJson(response, 429, { error: 'Login temporarily limited' });
        }
        const password = form.get('password') ?? '';
        if (Buffer.byteLength(password) > 1024) return oauthJson(response, 400, { error: 'Invalid credentials' });
        const matches = await argon2.verify(this.owner.passwordHash, password);
        if (form.get('action') !== 'login' || !matches) {
            return oauthJson(response, 403, { error: 'Invalid credentials' });
        }
        await this.provider.interactionFinished(
            request,
            response,
            { login: { accountId: this.owner.subject, remember: false } },
            { mergeWithLastSubmission: false },
        );
    }
}

function safeLocation(value: number | string | string[] | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    try {
        const url = new URL(value, 'https://discordinator.invalid');
        return `${url.origin}${url.pathname}`;
    } catch {
        return undefined;
    }
}
