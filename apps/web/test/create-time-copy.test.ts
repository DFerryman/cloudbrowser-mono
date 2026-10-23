import { expect, it } from 'vitest';
import { DOCS } from '../src/content/docs.js';
import { en } from '../src/messages/en.js';
import { zhCN } from '../src/messages/zh-CN.js';

// Creating a browser on AWS reserves an IP, creates a volume, boots a new VM and sets up Chrome on
// it: minutes, not the "1–2 minutes" the progress and the guide used to promise.
it('states the time a new browser takes to set up as it is on AWS', () => {
  expect(en['phase.typical']).toBe('Usually 3–8 minutes');
  expect(zhCN['phase.typical']).toBe('通常需要 3–8 分钟');
  const text = JSON.stringify(DOCS);
  expect(text).not.toMatch(/1–2 (minutes|分钟)/);
  expect(text).toContain('Setting up usually takes 3–8 minutes');
  expect(text).toContain('准备过程通常需要 3–8 分钟');
});
