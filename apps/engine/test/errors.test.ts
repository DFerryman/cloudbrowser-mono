import { expect, it } from 'vitest';
import { transientD1 } from '../src/errors.js';

it('recognizes D1 resetting its database as transient, through Drizzle\'s wrapping, and nothing else', () => {
  // As the metering step met it in production (wrapped by Drizzle, then by the step).
  const reset = new Error('D1_ERROR: Internal error in D1 DB storage caused object to be reset; reference = k7du80ip50u5kdrhai8fg4h4',
    { cause: new Error('Internal error in D1 DB storage caused object to be reset; reference = k7du80ip50u5kdrhai8fg4h4') });
  expect(transientD1(new Error('Failed query: UPDATE instance_health ...', { cause: reset }))).toBe(true);
  expect(transientD1(new Error('D1_ERROR: Network connection lost.'))).toBe(true);
  expect(transientD1(new Error('D1_ERROR: D1 DB is overloaded. Too many requests queued.'))).toBe(true);
  expect(transientD1(new Error('D1_ERROR: UNIQUE constraint failed: operations.instance_id'))).toBe(false);
  expect(transientD1(new Error('DescribeInstances: The operation was aborted due to timeout'))).toBe(false);
});
