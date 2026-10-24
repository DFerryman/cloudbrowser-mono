import type { ClosurePreview } from '@cloudbrowser/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AccountClosedPage } from '../src/features/account/AccountClosedPage.js';
import { CloseAccount } from '../src/features/account/CloseAccount.js';
import { api, ApiError } from '../src/lib/api.js';
import { I18nProvider } from '../src/lib/i18n.js';

vi.mock('../src/lib/api.js', async (original) => ({ ...await original(), api: vi.fn() }));
// The test renderer has no DOM for Radix's portal: the dialog's title, body and footer inline.
vi.mock('@cloudbrowser/ui', async (original) => ({
  ...await original(),
  Dialog: ({ open, title, children, footer }: { open: boolean; title: string; children: React.ReactNode; footer?: React.ReactNode }) =>
    open ? <div role="dialog"><h2>{title}</h2>{children}{footer}</div> : null,
}));

const preview: ClosurePreview = {
  blocker: null,
  browsers: [{ id: 'b1', name: 'Work' }, { id: 'b2', name: 'Shopping' }],
  balanceMicros: 26_500_000,
};

let rendered: ReturnType<typeof create>;
const assign = vi.fn();

function respond(p: ClosurePreview, close: unknown = { browsers: 2 }) {
  vi.mocked(api).mockImplementation(async (method: string, path: string) => {
    if (path === '/me') return { user: { email: 'owner@example.com' } };
    if (method === 'GET' && path === '/account/closure') return p;
    if (path === '/account/closure/code') return undefined;
    if (method === 'POST' && path === '/account/closure') {
      if (close instanceof Error) throw close;
      return close;
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
}

async function render(node: React.ReactNode, entry = '/account') {
  await act(async () => {
    rendered = create(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider locale="en">
          <MemoryRouter initialEntries={[entry]}>{node}</MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const text = (node: ReactTestInstance | null = rendered.root): string =>
  node ? node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('') : '';
const byTestId = (id: string) => rendered.root.find((n) => typeof n.type === 'string' && n.props['data-testid'] === id);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', { ...globalThis.window, location: { assign } });
  vi.mocked(api).mockReset();
  assign.mockReset();
});
afterEach(async () => { await act(async () => rendered.unmount()); vi.unstubAllGlobals(); });

test('shows what closing does, then closes with the emailed code and the box ticked', async () => {
  respond(preview);
  await render(<CloseAccount />);
  await act(async () => byTestId('close-account').props.onClick());
  await settle();
  const page = text();
  expect(page).toContain('Your browsers are permanently deleted, with everything saved in them (2):');
  expect(page).toContain('Work');
  expect(page).toContain('Shopping');
  expect(page).toContain('$26.50');
  expect(page).toContain('Closing does not refund your credit by itself. To ask about a refund of credit you paid for and have not used, write to support@nevazu.com from this email address, before you close or within 30 days after.');
  expect(rendered.root.find((n) => n.type === 'a' && n.props.href === 'mailto:support@nevazu.com')).toBeTruthy();

  await act(async () => rendered.root.find((n) => n.type === 'select').props.onChange({ target: { value: 'terms' } }));
  await act(async () => byTestId('close-send-code').props.onClick());
  await settle();
  expect(vi.mocked(api)).toHaveBeenCalledWith('POST', '/account/closure/code');
  expect(text()).toContain('We sent a 6-digit code to owner@example.com.');

  const confirm = () => byTestId('close-confirm');
  expect(confirm().props.disabled).toBe(true);
  await act(async () => rendered.root.find((n) => n.type === 'input' && n.props.autoComplete === 'one-time-code').props.onChange({ target: { value: '123456' } }));
  expect(confirm().props.disabled).toBe(true);
  await act(async () => byTestId('close-understand').props.onChange({ target: { checked: true } }));
  expect(confirm().props.disabled).toBe(false);
  await act(async () => confirm().props.onClick());
  await settle();
  expect(vi.mocked(api)).toHaveBeenLastCalledWith('POST', '/account/closure', { body: { code: '123456', confirm: true, reason: 'terms' } });
  expect(assign).toHaveBeenCalledWith('/account-closed');
});

test('a wrong code keeps the dialog open with the reason', async () => {
  respond(preview, new ApiError(400, { type: 'invalid_code', title: 'The code is not valid', status: 400, detail: 'That code is not right. Check the email and try again.' }));
  await render(<CloseAccount />);
  await act(async () => byTestId('close-account').props.onClick());
  await settle();
  await act(async () => byTestId('close-send-code').props.onClick());
  await settle();
  await act(async () => rendered.root.find((n) => n.type === 'input' && n.props.autoComplete === 'one-time-code').props.onChange({ target: { value: '000000' } }));
  await act(async () => byTestId('close-understand').props.onChange({ target: { checked: true } }));
  await act(async () => byTestId('close-confirm').props.onClick());
  await settle();
  expect(text()).toContain('That code is not right. Check the email and try again.');
  expect(assign).not.toHaveBeenCalled();
});

test('refuses here during a dispute hold, and says whom to write to', async () => {
  respond({ ...preview, blocker: 'dispute' });
  await render(<CloseAccount />);
  await act(async () => byTestId('close-account').props.onClick());
  await settle();
  expect(text()).toContain('A payment dispute is open on this account, so it cannot be closed here. Write to support@nevazu.com');
  expect(byTestId('close-send-code').props.disabled).toBe(true);
});

test('the closed page says where to ask about a refund, and when the data is erased', async () => {
  await render(<AccountClosedPage />, '/account-closed');
  expect(text()).toContain('To ask about a refund of credit you paid for and have not used, write to support@nevazu.com from your account’s email address within 30 days.');
  expect(text()).toContain('Your personal data is erased 30 days from now.');
});
