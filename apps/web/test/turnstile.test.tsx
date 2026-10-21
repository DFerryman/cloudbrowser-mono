import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { SignUpPage } from '../src/features/auth/SignUpPage.js';
import { SignInPage } from '../src/features/auth/SignInPage.js';
import { api } from '../src/lib/api.js';
import { useTurnstile } from '../src/features/auth/turnstile.js';

const state = vi.hoisted(() => ({ cached: 'site-key' as string | null, fresh: 'site-key' as string | null, navigate: vi.fn(), location: null as any, search: '' }));
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
vi.mock('react-router', () => ({ useNavigate: () => state.navigate, useLocation: () => ({ state: state.location }), useSearchParams: () => [new URLSearchParams(state.search)], Link: ({ children, to }: any) => React.createElement('a', { href: to }, children) }));
vi.mock('../src/features/auth/AuthLayout.js', () => ({ AuthLayout: ({ children }: any) => children, safeNext: () => '/browsers' }));
vi.mock('@cloudbrowser/ui', () => ({ Button: (props: any) => React.createElement('button', props), Input: (props: any) => React.createElement('input', props), Label: (props: any) => React.createElement('label', props) }));
let latest: ReturnType<typeof useTurnstile>;
let rendered: any;
let callbacks: Record<string, any>;
let ts: any;
function Harness() { latest = useTurnstile(); return latest.widget; }
beforeEach(() => {
 vi.mocked(api).mockReset();
 state.navigate.mockReset();
 state.location = null;
 state.search = '';
 state.cached = state.fresh = 'site-key';
 callbacks = {};
 ts = { render: vi.fn((_el, opts) => { callbacks = opts; return 'widget-id'; }), reset: vi.fn(), remove: vi.fn() };
 vi.stubGlobal('window', { turnstile: ts, setTimeout: (...args: any[]) => setTimeout(...args), clearTimeout: (id: any) => clearTimeout(id) });
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => { await act(async () => rendered?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => { rendered = create(React.createElement(Harness), { createNodeMock: () => ({ clientWidth: 360 }) }); }); }
test('mounts no challenge until an email is requested, then removes it without resetting', async () => {
 await mount();
 expect(ts.render).not.toHaveBeenCalled();
 expect(latest.active).toBe(false);
 let request: Promise<any>;
 await act(async () => { request = latest.headers(); });
 expect(latest.checking).toBe(true);
 expect(callbacks.appearance).toBe('always');
 expect(callbacks.size).toBe('flexible');
 await act(async () => callbacks.callback('verified-token'));
 expect(await request!).toEqual({ 'cf-turnstile-response': 'verified-token' });
 await act(async () => latest.finish());
 expect(ts.remove).toHaveBeenCalledWith('widget-id');
 expect(ts.reset).not.toHaveBeenCalled();
 expect(latest.active).toBe(false);
});

test('refreshes cached disabled settings before sending an email without reloading', async () => {
 state.cached = null;
 await mount();
 let request: Promise<any>;
 await act(async () => { request = latest.headers(); });
 expect(ts.render).toHaveBeenCalledOnce();
 await act(async () => callbacks.callback('new-token'));
 expect(await request!).toEqual({ 'cf-turnstile-response': 'new-token' });
 await act(async () => latest.finish());
});

test('does not run background checks after finishing; the next email gets a fresh challenge', async () => {
 vi.useFakeTimers();
 await mount();
 let first: Promise<any>;
 await act(async () => { first = latest.headers(); });
 await act(async () => callbacks.callback('first-token'));
 expect(await first!).toEqual({ 'cf-turnstile-response': 'first-token' });
 await act(async () => latest.finish());
 await act(async () => { vi.advanceTimersByTime(300_000); });
 expect(ts.render).toHaveBeenCalledOnce();
 let second: Promise<any>;
 await act(async () => { second = latest.headers(); });
 expect(ts.render).toHaveBeenCalledTimes(2);
 await act(async () => callbacks.callback('second-token'));
 expect(await second!).toEqual({ 'cf-turnstile-response': 'second-token' });
 await act(async () => latest.finish());
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
 await act(async () => latest.finish());
});

test('allows email requests without a widget when the latest settings disable Turnstile', async () => {
 state.cached = state.fresh = null;
 await mount();
 let value;
 await act(async () => { value = await latest.headers(); });
 expect(value).toEqual({});
 expect(ts.render).not.toHaveBeenCalled();
});

test('passkey selection needs no challenge; Email me a code instead checks once and removes it', async () => {
 vi.mocked(api).mockResolvedValueOnce({ method: 'passkey' }).mockResolvedValueOnce({});
 await act(async () => { rendered = create(React.createElement(SignInPage), { createNodeMock: () => ({ clientWidth: 360 }) }); });
 await act(async () => { void rendered.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
 expect(vi.mocked(api)).toHaveBeenCalledWith('POST', '/api/auth/sign-in/check', { body: { email: '' } });
 expect(ts.render).not.toHaveBeenCalled();
 const emailCode = rendered.root.findAllByType('button').find((b: any) => b.props.children === 'auth.passkey.emailCode');
 expect(emailCode.props.disabled).toBe(false);
 await act(async () => emailCode.props.onClick());
 expect(ts.render).toHaveBeenCalledOnce();
 expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
 await act(async () => callbacks.callback('code-token'));
 expect(vi.mocked(api)).toHaveBeenLastCalledWith('POST', '/api/auth/email-otp/send-verification-otp', expect.objectContaining({ headers: { 'cf-turnstile-response': 'code-token' } }));
 expect(rendered.root.findAllByType('input').some((input: any) => input.props.id === 'code')).toBe(true);
 expect(ts.remove).toHaveBeenCalledWith('widget-id');
 expect(ts.reset).not.toHaveBeenCalled();
});

test('automatically recovers a failed script download during an email request', async () => {
 vi.useFakeTimers();
 (window as any).turnstile = undefined;
 let loads = 0;
 vi.stubGlobal('document', { createElement: () => ({ remove: vi.fn() }), head: { appendChild: (script: any) => {
  if (++loads === 1) script.onerror();
  else { (window as any).turnstile = ts; (window as any).nevazuTurnstileReady(); }
 }} });
 await mount();
 expect(loads).toBe(0);
 let request: Promise<any>;
 await act(async () => { request = latest.headers(); });
 expect(latest.failed).toBe(true);
 await act(async () => { vi.advanceTimersByTime(8_000); });
 expect(loads).toBe(2);
 await act(async () => callbacks.callback('recovered-token'));
 expect(await request!).toEqual({ 'cf-turnstile-response': 'recovered-token' });
 await act(async () => latest.finish());
});

test('an existing email on sign-up continues to code entry and removes its challenge', async () => {
 vi.mocked(api).mockResolvedValueOnce({ method: 'code' });
 await act(async () => { rendered = create(React.createElement(SignUpPage), { createNodeMock: () => ({ clientWidth: 360 }) }); });
 expect(ts.render).not.toHaveBeenCalled();
 await act(async () => rendered.root.findByType('input').props.onChange({ target: { value: 'Pilot@Example.com' } }));
 await act(async () => { void rendered.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
 await act(async () => callbacks.callback('signup-token'));
 expect(state.navigate).toHaveBeenCalledWith('/sign-in?email=pilot%40example.com', { replace: true, state: { emailCodeSentFor: 'pilot@example.com' } });
 expect(ts.remove).toHaveBeenCalledWith('widget-id');
 expect(ts.reset).not.toHaveBeenCalled();
});

test('registration email success has no persistent challenge or reset', async () => {
 vi.mocked(api).mockResolvedValueOnce({ method: 'registration' });
 await act(async () => { rendered = create(React.createElement(SignUpPage), { createNodeMock: () => ({ clientWidth: 360 }) }); });
 await act(async () => { void rendered.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
 await act(async () => callbacks.callback('registration-token'));
 expect(rendered.root.findAllByProps({ role: 'status' }).length).toBe(1);
 expect(ts.remove).toHaveBeenCalledWith('widget-id');
 expect(ts.reset).not.toHaveBeenCalled();
});

test('redirected code entry mounts no widget and sends no extra email', async () => {
 state.search = 'email=pilot%40example.com';
 state.location = { emailCodeSentFor: 'pilot@example.com' };
 await act(async () => { rendered = create(React.createElement(SignInPage), { createNodeMock: () => ({ clientWidth: 360 }) }); });
 expect(rendered.root.findAllByType('input').some((input: any) => input.props.id === 'code')).toBe(true);
 expect(vi.mocked(api)).not.toHaveBeenCalled();
 expect(ts.render).not.toHaveBeenCalled();
});

test('unknown emails show registration without running any challenge or sending email', async () => {
 vi.mocked(api).mockResolvedValueOnce({ method: 'register' });
 await act(async () => { rendered = create(React.createElement(SignInPage), { createNodeMock: () => ({ clientWidth: 360 }) }); });
 await act(async () => rendered.root.findByType('input').props.onChange({ target: { value: 'Fresh@Example.com' } }));
 await act(async () => { void rendered.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
 expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
 expect(ts.render).not.toHaveBeenCalled();
 expect(rendered.root.findAllByType('a').some((a: any) => a.props.href === '/sign-up?email=fresh%40example.com')).toBe(true);
});

test('email-code sign-in verifies only the mail request, then code and TOTP have no widget', async () => {
 vi.mocked(api).mockResolvedValueOnce({ method: 'code' }).mockResolvedValueOnce({}).mockResolvedValueOnce({ twoFactorRedirect: true });
 await act(async () => { rendered = create(React.createElement(SignInPage), { createNodeMock: () => ({ clientWidth: 360 }) }); });
 await act(async () => { void rendered.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
 expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
 await act(async () => callbacks.callback('email-token'));
 expect(ts.remove).toHaveBeenCalledWith('widget-id');
 await act(async () => rendered.root.findByType('input').props.onChange({ target: { value: '123456' } }));
 await act(async () => { void rendered.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
 expect(rendered.root.findAllByType('input').some((input: any) => input.props.id === 'second-factor')).toBe(true);
 expect(ts.render).toHaveBeenCalledOnce();
 expect(ts.reset).not.toHaveBeenCalled();
});

test('waits for the script API ready callback and exposes loading instead of hiding the check', async () => {
 (window as any).turnstile = undefined;
 let script: any;
 vi.stubGlobal('document', { createElement: () => ({ remove: vi.fn() }), head: { appendChild: (s: any) => { script = s; } } });
 await mount();
 let request: Promise<any>;
 await act(async () => { request = latest.headers(); });
 expect(script.src).toContain('onload=nevazuTurnstileReady');
 expect(ts.render).not.toHaveBeenCalled();
 expect(latest.loadingWidget).toBe(true);
 await act(async () => { (window as any).turnstile = ts; (window as any).nevazuTurnstileReady(); });
 expect(ts.render).toHaveBeenCalledOnce();
 expect(callbacks.appearance).toBe('always');
 expect(latest.loadingWidget).toBe(false);
 await act(async () => callbacks.callback('ready-token'));
 expect(await request!).toEqual({ 'cf-turnstile-response': 'ready-token' });
 await act(async () => latest.finish());
});

test('a stalled verification has an in-page retry button and still sends only one email', async () => {
 vi.mocked(api).mockResolvedValueOnce({ method: 'registration' });
 await act(async () => { rendered = create(React.createElement(SignUpPage), { createNodeMock: () => ({ clientWidth: 360 }) }); });
 await act(async () => { void rendered.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
 expect(vi.mocked(api)).not.toHaveBeenCalled();
 const retry = rendered.root.findAllByType('button').find((b: any) => b.props.children === 'browsers.tryAgain');
 expect(retry).toBeDefined();
 expect(retry.props.disabled).not.toBe(true);
 await act(async () => retry.props.onClick());
 expect(ts.render).toHaveBeenCalledTimes(2);
 await act(async () => callbacks.callback('retry-token'));
 expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
 expect(ts.remove).toHaveBeenCalledWith('widget-id');
});
