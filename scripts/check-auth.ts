import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { Authenticator } from '../src/mcp/auth.js';
import { fakeConfig } from './fixtures.js';

export async function checkAuth(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const config = { ...fakeConfig(), DOTBOT_AUTH_MODE: 'oauth' as const, DOTBOT_RESOURCE_URL: 'https://dotbot.example/mcp',
    DOTBOT_OAUTH_ISSUER: 'https://issuer.example', DOTBOT_OAUTH_JWKS_URL: 'https://issuer.example/jwks', DOTBOT_OAUTH_SUBJECTS: 'owner' };
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'validation', alg: 'RS256' }] });
  const auth = new Authenticator(config, keys);
  const accepts = (token: string) => auth.accepts({ headers: { authorization: `Bearer ${token}` } } as IncomingMessage);
  const token = (scope = 'dotbot:control', subject = 'owner', audience = config.DOTBOT_RESOURCE_URL, issuer = config.DOTBOT_OAUTH_ISSUER) =>
    new SignJWT({ scope }).setProtectedHeader({ alg: 'RS256', kid: 'validation' }).setSubject(subject)
      .setAudience(audience).setIssuer(issuer).setIssuedAt().setExpirationTime('1m').sign(privateKey);
  assert.equal(await accepts(await token()), true);
  assert.equal(await accepts(await token('other:scope')), false);
  assert.equal(await accepts(await token('dotbot:control', 'stranger')), false);
  assert.equal(await accepts(await token('dotbot:control', 'owner', 'https://other.example/mcp')), false);
  assert.equal(await accepts(await token('dotbot:control', 'owner', config.DOTBOT_RESOURCE_URL, 'https://wrong.example')), false);
  assert.equal(await accepts('invalid.signature.value'), false);
  const expired = await new SignJWT({ scope: 'dotbot:control' }).setProtectedHeader({ alg: 'RS256', kid: 'validation' })
    .setSubject('owner').setAudience(config.DOTBOT_RESOURCE_URL).setIssuer(config.DOTBOT_OAUTH_ISSUER)
    .setIssuedAt().setExpirationTime(1).sign(privateKey);
  assert.equal(await accepts(expired), false);
  assert.equal(auth.metadata().resource, config.DOTBOT_RESOURCE_URL);
  assert.ok(auth.challenge().includes('resource_metadata='));
}
