/**
 * Coding agents' OAuth sign-in, the signed-in half (docs/agent-access.md, "OAuth sign-in"): what the
 * approval page shows and the owner's answer, and the account's Connected agents (every key and
 * sign-in across browsers). The public endpoints apps call are in ../oauth.ts.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { AgentConnection, OAuthAuthorizeCheck, OAuthCheckBody, OAuthDecision, OAuthDecisionBody, Problem } from '@cloudbrowser/contracts';
import { schema } from '@cloudbrowser/db';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { listed, revokeUserClient, revokeUserClients, toAutomationClient, unavailable } from '../automation.js';
import type { AppEnv } from '../env.js';
import { checkAuthorization, decideAuthorization } from '../oauth.js';
import { problem } from '../problem.js';

const { automationClients, browserInstances, oauthClients } = schema;

export const oauthRoute = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) {
      throw problem(400, 'validation_failed', result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
  },
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({ content: { 'application/json': { schema } }, description });
const errors = {
  400: { content: { 'application/problem+json': { schema: Problem } }, description: 'Invalid request' },
  401: { content: { 'application/problem+json': { schema: Problem } }, description: 'Not signed in' },
  404: { content: { 'application/problem+json': { schema: Problem } }, description: 'Not found' },
  409: { content: { 'application/problem+json': { schema: Problem } }, description: 'Conflict' },
};

oauthRoute.openapi(
  createRoute({
    method: 'post',
    path: '/oauth/authorize/check',
    tags: ['automation'],
    description: 'Reads an app\'s authorization request for the approval page: the app, where approving returns to, the browser it asked for (or the browsers to pick from), and the choices. A request that cannot be approved says why, and whether the app may be told.',
    request: { body: { content: { 'application/json': { schema: OAuthCheckBody } }, required: true } },
    responses: { 200: json(OAuthAuthorizeCheck, 'What to show, or why not'), ...errors },
  }),
  async (c) => c.json(await checkAuthorization(c.get('db'), c.env, c.get('user').id, c.req.valid('json').params), 200),
);

oauthRoute.openapi(
  createRoute({
    method: 'post',
    path: '/oauth/authorize/decision',
    tags: ['automation'],
    description: 'The owner approves (browser, permission, how many days) or declines an app\'s request. Returns the app\'s callback with a one-time code or an error; the page navigates there. Approving emails the owner.',
    request: { body: { content: { 'application/json': { schema: OAuthDecisionBody } }, required: true } },
    responses: { 200: json(OAuthDecision, 'Where to go next'), ...errors },
  }),
  async (c) => c.json(await decideAuthorization(c.get('db'), c.env, (p) => c.executionCtx.waitUntil(p), c.get('user').id, c.req.valid('json')), 200),
);

oauthRoute.openapi(
  createRoute({
    method: 'get',
    path: '/agent-connections',
    tags: ['automation'],
    description: 'Every coding-agent key and sign-in of your browsers, newest first. A sign-in that has ended is listed for a day more.',
    responses: { 200: json(z.array(AgentConnection), 'Keys and sign-ins'), ...errors },
  }),
  async (c) => {
    const now = Date.now();
    const rows = await c.get('db')
      .select({ client: automationClients, app: { id: oauthClients.id, kind: oauthClients.kind }, instanceName: browserInstances.name, desiredState: browserInstances.desiredState, status: browserInstances.status })
      .from(automationClients)
      .innerJoin(browserInstances, eq(browserInstances.id, automationClients.instanceId))
      .leftJoin(oauthClients, eq(oauthClients.id, automationClients.oauthClientId))
      .where(and(eq(automationClients.userId, c.get('user').id), isNull(automationClients.revokedAt), isNotNull(automationClients.credentialHash)))
      .orderBy(desc(automationClients.createdAt));
    return c.json(rows.filter((r) => listed(r.client, now) && !unavailable(r)).map((r) => ({
      ...toAutomationClient(r.client, r.app), instanceId: r.client.instanceId, instanceName: r.instanceName,
    })), 200);
  },
);

oauthRoute.openapi(
  createRoute({
    method: 'delete',
    path: '/agent-connections/{clientId}',
    tags: ['automation'],
    description: 'Disconnects one key or sign-in of any of your browsers: it stops working and its session is closed at once.',
    request: { params: z.object({ clientId: z.string().min(1).max(64) }) },
    responses: { 204: { description: 'Disconnected' }, ...errors },
  }),
  async (c) => {
    if (!(await revokeUserClient(c.get('db'), c.env, c.get('user').id, c.req.valid('param').clientId))) throw problem(404, 'not_found');
    return c.body(null, 204);
  },
);

oauthRoute.openapi(
  createRoute({
    method: 'delete',
    path: '/agent-connections',
    tags: ['automation'],
    description: 'Disconnects every key and sign-in of every browser of yours.',
    responses: { 200: json(z.object({ revoked: z.number().int() }), 'How many were disconnected'), ...errors },
  }),
  async (c) => c.json({ revoked: await revokeUserClients(c.get('db'), c.env, c.get('user').id, new Date(), 'disconnect_all') }, 200),
);
