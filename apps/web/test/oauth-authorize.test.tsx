import type { OAuthAuthorizeCheck } from '@cloudbrowser/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthorizePage } from '../src/features/oauth/AuthorizePage.js';
import { api, ApiError } from '../src/lib/api.js';
import { I18nProvider } from '../src/lib/i18n.js';

vi.mock('../src/lib/api.js', async (original) => ({ ...await original(), api: vi.fn() }));
vi.mock('../src/app/AppShell.js', () => ({ Logo: () => null }));
vi.mock('../src/app/Preferences.js', () => ({ LanguageButton: () => null, ThemeButton: () => null }));

const QUERY = '?response_type=code&client_id=nvzc_AAAAAAAAAAAAAAAAAAAAAAAA&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcb&state=s1';
const approval: OAuthAuthorizeCheck = {
  ok: true, client: { name: 'Cursor', verifiedHost: null }, redirect: { kind: 'loopback', label: '127.0.0.1' }, capability: 'control',
  browser: null, browsers: [{ id: 'b1', name: 'Work', agentAccess: true }, { id: 'b2', name: 'Shopping', agentAccess: false }],
  grantDays: [1, 7, 30, 90], defaultGrantDays: 7,
};

let rendered: ReturnType<typeof create>;
const assign = vi.fn();

function respond(check: OAuthAuthorizeCheck | Error, me: unknown = { user: { email: 'owner@example.com' } }) {
  vi.mocked(api).mockImplementation(async (method: string, path: string) => {
    if (path === '/me') {
      if (me instanceof Error) throw me;
      return me;
    }
    if (path === '/oauth/authorize/check') {
      if (check instanceof Error) throw check;
      return check;
    }
    if (path === '/oauth/authorize/decision') return { redirect: 'http://127.0.0.1:5000/cb?code=abc&state=s1&iss=https%3A%2F%2Fnevazu.com' };
    throw new Error(`unexpected ${method} ${path}`);
  });
}

async function render(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  await act(async () => {
    rendered = create(
      <QueryClientProvider client={client}>
        <I18nProvider locale="en">
          <MemoryRouter initialEntries={[`/oauth/authorize${QUERY}`]}>
            <Routes>
              <Route path="/oauth/authorize" element={<AuthorizePage />} />
              <Route path="/sign-in" element={<p>sign in page</p>} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  // The account, then the request's check.
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const text = (node: ReactTestInstance | null = rendered.root): string =>
  node ? node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('') : '';
const button = (label: string) => rendered.root.find((n) => n.type === 'button' && text(n).trim() === label);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', { location: { assign, pathname: '/oauth/authorize', search: QUERY } });
  vi.mocked(api).mockReset();
  assign.mockReset();
});
afterEach(async () => { await act(async () => rendered.unmount()); vi.unstubAllGlobals(); });

test('shows the request, and approves the chosen browser, permission and days, then goes back to the app', async () => {
  respond(approval);
  await render();
  expect(vi.mocked(api)).toHaveBeenCalledWith('POST', '/oauth/authorize/check', { body: { params: {
    response_type: 'code', client_id: 'nvzc_AAAAAAAAAAAAAAAAAAAAAAAA', redirect_uri: 'http://127.0.0.1:5000/cb', state: 's1',
  } } });
  const page = text();
  expect(page).toContain('Allow Cursor to use your cloud browser?');
  expect(page).toContain('Nevazu cannot verify it');
  expect(page).toContain('the app on this computer that started the sign-in');
  expect(page).toContain('Signed in as owner@example.com.');
  // Seven days is chosen to begin with.
  expect(rendered.root.find((n) => n.props.role === 'radio' && n.props['aria-checked'] === true).children.join('')).toBe('7 days');

  await act(async () => rendered.root.find((n) => n.type === 'select').props.onChange({ target: { value: 'b2' } }));
  expect(text()).toContain('Allowing turns it on.');
  await act(async () => button('30 days').props.onClick());
  await act(async () => rendered.root.find((n) => n.type === 'input' && n.props.value === 'view').props.onChange());
  await act(async () => button('Allow').props.onClick());
  expect(vi.mocked(api)).toHaveBeenLastCalledWith('POST', '/oauth/authorize/decision', { body: {
    params: expect.objectContaining({ client_id: 'nvzc_AAAAAAAAAAAAAAAAAAAAAAAA', state: 's1' }),
    approve: true, grantDays: 30, capability: 'view', enableAccess: true, instanceId: 'b2',
  } });
  expect(assign).toHaveBeenCalledWith('http://127.0.0.1:5000/cb?code=abc&state=s1&iss=https%3A%2F%2Fnevazu.com');
  expect(text()).toContain('Cursor can now use your browser');
});

test('denies, and names no browser when the app named one', async () => {
  respond({ ...approval, browser: { id: 'b1', name: 'Work', agentAccess: true }, browsers: [], capability: 'view' });
  await render();
  expect(rendered.root.findAll((n) => n.type === 'select')).toHaveLength(0);
  expect(text()).toContain('Cursor asked for view only.');
  expect(rendered.root.find((n) => n.type === 'input' && n.props.value === 'control').props.disabled).toBe(true);
  await act(async () => button('Deny').props.onClick());
  expect(vi.mocked(api)).toHaveBeenLastCalledWith('POST', '/oauth/authorize/decision', { body: expect.objectContaining({ approve: false, enableAccess: false }) });
  expect(vi.mocked(api).mock.lastCall?.[2]?.body).not.toHaveProperty('instanceId');
  expect(text()).toContain('Cursor was not allowed');
});

test('denies with no browser to choose from', async () => {
  respond({ ...approval, browsers: [] });
  await render();
  expect(text()).toContain('You have no browser yet.');
  expect(button('Allow').props.disabled).toBe(true);
  await act(async () => button('Deny').props.onClick());
  expect(vi.mocked(api).mock.lastCall?.[2]?.body).toEqual(expect.objectContaining({ approve: false }));
  expect(vi.mocked(api).mock.lastCall?.[2]?.body).not.toHaveProperty('instanceId');
  expect(assign).toHaveBeenCalledWith(expect.stringContaining('http://127.0.0.1:5000/cb'));
});

test('checks the request again when the owner comes back, with a browser created meanwhile', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  respond({ ...approval, browsers: [] });
  await render(client);
  expect(button('Allow').props.disabled).toBe(true);
  await act(async () => rendered.unmount());
  respond({ ...approval, browsers: [{ id: 'b3', name: 'New', agentAccess: true }] });
  await render(client);
  expect(button('Allow').props.disabled).toBe(false);
  await act(async () => button('Allow').props.onClick());
  expect(vi.mocked(api).mock.lastCall?.[2]?.body).toEqual(expect.objectContaining({ approve: true, instanceId: 'b3' }));
});

test('explains a request it cannot approve, and offers the way back only when the app may be told', async () => {
  respond({ ok: false, error: 'invalid_client', description: 'This app is not known to Nevazu.', redirect: null });
  await render();
  expect(text()).toContain('This sign-in can’t be approved');
  expect(text()).toContain('This app is not known to Nevazu.');
  expect(rendered.root.findAll((n) => n.type === 'button' && text(n) === 'Return to the app')).toHaveLength(0);
  await act(async () => rendered.unmount());

  respond({ ok: false, error: 'invalid_target', description: 'Not your browser.', redirect: 'http://127.0.0.1:5000/cb?error=invalid_target' });
  await render();
  await act(async () => button('Return to the app').props.onClick());
  expect(assign).toHaveBeenCalledWith('http://127.0.0.1:5000/cb?error=invalid_target');
});

test('sends a signed-out visitor to sign in, and back with the request', async () => {
  respond(approval, new ApiError(401, { type: 'unauthenticated', title: 'Sign in', status: 401 }));
  await render();
  expect(text()).toBe('sign in page');
  expect(vi.mocked(api)).not.toHaveBeenCalledWith('POST', '/oauth/authorize/check', expect.anything());
});
