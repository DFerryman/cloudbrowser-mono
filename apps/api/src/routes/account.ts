/**
 * Closing the signed-in user's account (../closure.ts): what it would do, the email code that
 * confirms it, and the closure itself.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { CloseAccountBody, ClosurePreview, ClosureResult, Problem } from '@cloudbrowser/contracts';
import { closeAccount, closurePreview, sendClosureCode } from '../closure.js';
import type { AppEnv } from '../env.js';
import { problem } from '../problem.js';

export const accountRoute = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) {
      throw problem(400, 'validation_failed', result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
  },
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({ content: { 'application/json': { schema } }, description });
const problemJson = (description: string) => ({ content: { 'application/problem+json': { schema: Problem } }, description });
const refusals = {
  400: problemJson('Invalid request or code'),
  403: problemJson('Operator account'),
  409: problemJson('Dispute hold, suspended browser, or already closing'),
  429: problemJson('A code was just sent'),
};

/** Better Auth's session cookies; the closure deletes the session itself, these clear the browser's copy. */
const SESSION_COOKIES = ['better-auth.session_token', 'better-auth.session_data', '__Secure-better-auth.session_token', '__Secure-better-auth.session_data'];

accountRoute.openapi(
  createRoute({
    method: 'get',
    path: '/account/closure',
    tags: ['account'],
    description: 'What closing the account would do now: the browsers deleted, the balance, and why it cannot be closed here, if it cannot.',
    responses: { 200: json(ClosurePreview, 'Closure preview') },
  }),
  async (c) => c.json(await closurePreview(c.get('db'), c.env, c.get('user')), 200),
);

accountRoute.openapi(
  createRoute({
    method: 'post',
    path: '/account/closure/code',
    tags: ['account'],
    description: 'Emails a 6-digit code that confirms closing the account. It works for 5 minutes; a new one replaces it, at most one a minute.',
    responses: { 204: { description: 'Sent' }, ...refusals },
  }),
  async (c) => {
    await sendClosureCode(c.env, c.get('db'), c.get('user'));
    return c.body(null, 204);
  },
);

accountRoute.openapi(
  createRoute({
    method: 'post',
    path: '/account/closure',
    tags: ['account'],
    description: 'Closes the account: signs out everywhere and permanently deletes every browser. It refunds nothing by itself; a refund of unused paid credit is agreed with support. Personal data is erased after 30 days. This cannot be undone.',
    request: { body: { content: { 'application/json': { schema: CloseAccountBody } }, required: true } },
    responses: { 200: json(ClosureResult, 'Closed'), ...refusals },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const result = await closeAccount(c, { code: body.code, reason: body.reason });
    for (const name of SESSION_COOKIES) {
      c.header('set-cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${name.startsWith('__Secure-') ? '; Secure' : ''}`, { append: true });
    }
    return c.json(result, 200);
  },
);
