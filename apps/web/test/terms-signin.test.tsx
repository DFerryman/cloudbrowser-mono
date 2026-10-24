import { TERMS_VERSION } from '@cloudbrowser/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { signOut } from '../src/app/AppShell.js';
import { TermsAcceptanceGate } from '../src/features/auth/TermsAcceptanceGate.js';
import { api } from '../src/lib/api.js';

vi.mock('../src/app/AppShell.js', () => ({ signOut: vi.fn() }));
vi.mock('../src/features/instances/hooks.js', () => ({ useMe: () => ({ isSuccess: true, isPending: false, isError: false, data: { user: { id: 'u1' } } }) }));
vi.mock('../src/lib/api.js', async original => ({ ...await original(), api: vi.fn() }));
vi.mock('../src/lib/i18n.js', async () => {
  const { en } = await import('../src/messages/en.js');
  return { useI18n: () => ({ t: (key: keyof typeof en) => en[key], errorMessage: () => 'Request failed' }) };
});
vi.mock('@cloudbrowser/ui', async () => {
  const React = await import('react');
  return {
    Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('button', props, children),
    Hint: ({ children }: React.PropsWithChildren) => React.createElement('small', null, children),
    Dialog: ({ title, description, children, footer }: React.PropsWithChildren<{ title: string; description: string; footer: React.ReactNode }>) => React.createElement('div', { role: 'dialog' }, title, description, children, footer),
  };
});

let rendered: ReturnType<typeof create>;
let client: QueryClient;
const state = (accepted = false, version = TERMS_VERSION) => ({ termsVersion: version, termsAccepted: accepted });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
async function mount() {
  await act(async () => {
    rendered = create(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/browsers']}><Routes><Route element={<TermsAcceptanceGate />}><Route path="/browsers" element={<span data-testid="private-page">Private page</span>} /></Route></Routes></MemoryRouter></QueryClientProvider>);
  });
  await flush();
}
const confirm = () => rendered.root.findByProps({ 'data-testid': 'consent-confirm' });
const privatePage = () => rendered.root.findAllByProps({ 'data-testid': 'private-page' });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(api).mockReset();
  vi.mocked(signOut).mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => { if (rendered) await act(async () => rendered.unmount()); client.clear(); vi.unstubAllGlobals(); });

test('an unaccepted revision blocks the private page until the user ticks and confirms, without paying', async () => {
  vi.mocked(api).mockImplementation(async method => method === 'POST' ? state(true) : state(false));
  await mount();
  expect(privatePage()).toHaveLength(0);
  expect(confirm().props.disabled).toBe(true);
  expect(vi.mocked(api).mock.calls).toHaveLength(1);
  await act(async () => rendered.root.findByType('input').props.onChange({ target: { checked: true } }));
  expect(confirm().props.disabled).toBe(false);
  await act(async () => confirm().props.onClick());
  await flush();
  expect(privatePage()).toHaveLength(1);
  expect(vi.mocked(api).mock.calls).toEqual([
    ['GET', '/terms-consent'],
    ['POST', '/terms-consent', { body: { acceptedTermsVersion: TERMS_VERSION } }],
  ]);
});

test('a current acceptance enters without a prompt or a new acceptance record', async () => {
  vi.mocked(api).mockResolvedValue(state(true));
  await mount();
  expect(privatePage()).toHaveLength(1);
  expect(rendered.root.findAllByType('input')).toHaveLength(0);
  expect(vi.mocked(api).mock.calls).toEqual([['GET', '/terms-consent']]);
});

test('declining signs out without accepting or entering the private page', async () => {
  vi.mocked(api).mockResolvedValue(state(false));
  await mount();
  const button = rendered.root.findAllByType('button').find(b => b.children.includes('Sign out'))!;
  await act(async () => button.props.onClick());
  expect(signOut).toHaveBeenCalledOnce();
  expect(privatePage()).toHaveLength(0);
  expect(vi.mocked(api).mock.calls).toHaveLength(1);
});

test('a stale frontend cannot confirm a different revision, and request failures do not enter', async () => {
  vi.mocked(api).mockResolvedValue(state(false, 'future-version'));
  await mount();
  expect(privatePage()).toHaveLength(0);
  expect(rendered.root.findAllByType('input')).toHaveLength(0);
  expect(rendered.root.findAllByType('button').some(b => b.children.includes('Reload'))).toBe(true);
  await act(async () => rendered.unmount());
  client.clear();
  vi.mocked(api).mockRejectedValue(new Error('Offline'));
  await mount();
  expect(privatePage()).toHaveLength(0);
  expect(rendered.root.findAllByType('button').some(b => b.children.includes('Retry'))).toBe(true);
});
