/** Promotions (dashboard): the user's tasks, their progress and the rewards earned. */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { PromotionTask } from '@cloudbrowser/contracts';
import type { AppEnv } from '../env.js';
import { problem } from '../problem.js';
import { userPromotions } from '../promotions.js';

export const promotionsRoute = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) {
      throw problem(400, 'validation_failed', result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
  },
});

promotionsRoute.openapi(
  createRoute({
    method: 'get',
    path: '/promotions',
    tags: ['billing'],
    description: 'Tasks that earn credit, with your progress. A task you have finished is completed and its reward credited before this returns.',
    responses: { 200: { content: { 'application/json': { schema: z.array(PromotionTask) } }, description: 'Pending and completed tasks' } },
  }),
  async (c) => c.json(await userPromotions(c.env, c.get('db'), c.get('user').id), 200),
);
