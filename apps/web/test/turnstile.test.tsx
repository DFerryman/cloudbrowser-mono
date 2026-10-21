import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { SignInPage } from '../src/features/auth/SignInPage.js';
import { api } from '../src/lib/api.js';
import { useTurnstile } from '../src/features/auth/turnstile.js';

const state = vi.hoisted(() => ({ cached: 'site-key' as string | null, fresh: 'site-key' as string | null }));
vi.mock('../src/lib/i18n.js', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));
vi.mock('../src/lib/theme.js', () => ({ useTheme: () => ({ theme: 'system' }) }));
vi.mock('@tanstack/react-query', async () => {
 const React = await import('react');
 return { useQuery: () => {
  const [data, setData] = React.useState({ turnstileSiteKey: state.cached });
  const refetch = React.useCallback(async () => {
   const data = { turnstileSiteKey: state.fresh };
   setData(data);
   return { isSuccess: true, data };
  }, []);
  return { data, isSuccess: true, isFetching: false, isError: false, refetch };
 }};
});
vi.mock('../src/lib/api.js', async (original) => ({ ...await original(), api: vi.fn() }));
vi.mock('../src/lib/query.js', () => ({ queryClient: { clear: vi.fn() } }));
vi.mock('../src/site/hooks.js', () => ({ useSignedIn: () => false }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn(), useSearchParams: () => [new URLSearchParams()], Link: ({ children }: any) => children }));
vi.mock('../src/features/auth/AuthLayout.js', () => ({ AuthLayout: ({ children }: any) => children, safeNext: () => '/browsers' }));
vi.mock('@cloudbrowser/ui', () => ({ Button: (props: any) => React.createElement('button', props), Input: (props: any) => React.createElement('input', props), Label: (props: any) => React.createElement('label', props) }));
let latest: ReturnType<typeof useTurnstile>;
let rendered: any;
let callbacks: Record<string, any>;
let ts: any;
function Harness() { latest = useTurnstile(); return latest.widget; }
beforeEach(() => {
 vi.mocked(api).mockReset();
 state.cached = state.fresh = 'site-key';
 callbacks = {};
 ts = { render: vi.fn((_el, opts) => { callbacks = opts; return 'widget-id'; }), reset: vi.fn(), remove: vi.fn() };
 vi.stubGlobal('window', { turnstile: ts, setTimeout: (...args: any[]) => setTimeout(...args), clearTimeout: (id: any) => clearTimeout(id) });
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => { await act(async () => rendered?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => { rendered = create(React.createElement(Harness), { createNodeMock: () => ({}) }); }); }
test('one click waits for the challenge, then continues with its token without resetting it early', async () => {
 await mount();
 let request: Promise<any>;
 await act(async () => { request = latest.headers(); });
 expect(latest.checking).toBe(true);
 expect(ts.reset).not.toHaveBeenCalled();
 await act(async () => callbacks.callback('verified-token'));
 expect(await request!).toEqual({ 'cf-turnstile-response': 'verified-token' });
 expect(ts.reset).not.toHaveBeenCalled();
 await act(async () => latest.reset());
 expect(ts.reset).toHaveBeenCalledWith('widget-id');
});
test('refreshes cached disabled settings on submit and mounts a challenge without reloading', async () => {
 state.cached = null;
 await mount();
 expect(ts.render).not.toHaveBeenCalled();
 let request: Promise<any>;
 await act(async () => { request = latest.headers(); });
 expect(ts.render).toHaveBeenCalledOnce();
 await act(async () => callbacks.callback('new-token'));
 expect(await request!).toEqual({ 'cf-turnstile-response': 'new-token' });
});
test('an expired token waits for a new challenge instead of sending a missing token', async () => {
 await mount();
 await act(async () => callbacks.callback('expired-token'));
 await act(async () => callbacks['expired-callback']());
 let request: Promise<any>;
 await act(async () => { request = latest.headers(); });
 expect(latest.checking).toBe(true);
 await act(async () => callbacks.callback('fresh-token'));
 expect(await request!).toEqual({ 'cf-turnstile-response': 'fresh-token' });
});
test('failed challenges automatically remount and let the waiting click continue', async () => {
 vi.useFakeTimers();
 await mount();
 let request: Promise<any>;
 await act(async () => { request = latest.headers(); });
 await act(async () => callbacks['error-callback']());
 expect(latest.failed).toBe(true);
 await act(async () => { vi.advanceTimersByTime(8_000); });
 expect(ts.render).toHaveBeenCalledTimes(2);
 await act(async () => callbacks.callback('retried-token'));
 expect(await request!).toEqual({ 'cf-turnstile-response': 'retried-token' });
});
test('allows requests without a widget when the latest server settings disable Turnstile', async () => {
 state.cached = state.fresh = null;
 await mount();
 let value;
 await act(async () => { value = await latest.headers(); });
 expect(value).toEqual({});
});

test('keeps Email me a code instead clickable and sends the code after one click and verification', async () => {
 vi.mocked(api).mockResolvedValueOnce({ method: 'passkey' }).mockResolvedValueOnce({});
 await act(async () => { rendered = create(React.createElement(SignInPage), { createNodeMock: () => ({}) }); });
 expect(rendered.root.findAllByType('button').find((b: any) => b.props.children === 'auth.continue').props.disabled).toBe(false);
 await act(async () => rendered.root.findByType('form').props.onSubmit({ preventDefault() {} }));
 await act(async () => callbacks.callback('first-token'));
 const emailCode = () => rendered.root.findAllByType('button').find((b: any) => b.props.children === 'auth.passkey.emailCode');
 expect(emailCode().props.disabled).toBe(false);
 await act(async () => emailCode().props.onClick());
 expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
 await act(async () => callbacks.callback('second-token'));
 expect(vi.mocked(api)).toHaveBeenLastCalledWith('POST', '/api/auth/email-otp/send-verification-otp', expect.objectContaining({ headers: { 'cf-turnstile-response': 'second-token' } }));
 expect(rendered.root.findAllByType('input').some((input: any) => input.props.id === 'code')).toBe(true);
});

test('automatically recovers a failed initial script download without refreshing', async () => {
 vi.useFakeTimers();
 (window as any).turnstile = undefined;
 let loads = 0;
 vi.stubGlobal('document', { createElement: () => ({ remove: vi.fn() }), head: { appendChild: (script: any) => {
  if (++loads === 1) script.onerror();
  else { (window as any).turnstile = ts; script.onload(); }
 }} });
 await mount();
 expect(latest.failed).toBe(true);
 await act(async () => { vi.advanceTimersByTime(8_000); });
 expect(loads).toBe(2);
 expect(ts.render).toHaveBeenCalledOnce();
 await act(async () => callbacks.callback('recovered-token'));
 let value;
 await act(async () => { value = await latest.headers(); });
 expect(value).toEqual({ 'cf-turnstile-response': 'recovered-token' });
});
