import type { ConnectInfo, Instance, ViewerSession } from '@cloudbrowser/contracts';
import { Button, cn, Menu, MenuItem, RegionIpChip, StatusBadge, useToast } from '@cloudbrowser/ui';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ClipboardCopy,
  Command,
  Download,
  Gauge,
  Keyboard,
  Maximize,
  Minimize,
  Moon,
  MoreHorizontal,
  RotateCw,
  Settings,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { COMBOS, qualityLevel, type ViewerState, type ViewerStats } from '@cloudbrowser/viewer';
import { RemoteBrowserView, type RemoteBrowserHandle } from '@cloudbrowser/viewer/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import { keys, queryClient } from '../../lib/query.js';
import { CreateProgress } from '../instances/CreateProgress.js';
import { useInstance, useLifecycle, useVerifyIp } from '../instances/hooks.js';
import { regionInfo, STATUS_TONE, statusKey } from '../instances/status.js';

const HEARTBEAT_MS = 15_000;
const IDLE_WARNING_MS = 60_000;

type HeartbeatResult = { sleepAt: string | null; reason?: 'idle' | 'balance' | 'trial' };

/**
 * Live session (`/b/:id`, page 1 and page 5). The dark frame keeps attention on the remote page.
 * While browsers run on the fake executor the stream area shows a simulated Chrome; the real
 * viewer (packages/viewer, neko over the gateway) plugs into the same shell.
 */
export function SessionPage() {
  const { id = '' } = useParams();
  const { t, errorMessage } = useI18n();
  const navigate = useNavigate();
  const instance = useInstance(id);
  const lifecycle = useLifecycle();
  const verify = useVerifyIp();
  const frameRef = useRef<HTMLDivElement>(null);
  const hadInput = useRef(false);

  const [session, setSession] = useState<ViewerSession | null>(null);
  const [openError, setOpenError] = useState<unknown>(null);
  const [takenOver, setTakenOver] = useState(false);
  const [sleepAt, setSleepAt] = useState<number | null>(null);
  /** `balance`: the prepaid balance ran out; input does not keep the browser awake. */
  const [sleepReason, setSleepReason] = useState<'idle' | 'balance' | 'trial'>('idle');
  const [now, setNow] = useState(Date.now());
  const [fullscreen, setFullscreen] = useState(false);
  const viewerRef = useRef<RemoteBrowserHandle>(null);
  const [viewer, setViewer] = useState<{ state: ViewerState; attempt: number }>({ state: 'connecting', attempt: 0 });
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [muted, setMuted] = useState(true);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [visibleHeight, setVisibleHeight] = useState<number | null>(null);

  const open = useCallback(async () => {
    setOpenError(null);
    try {
      const r = await api<{ session: ViewerSession; operationId: string | null }>('POST', `/instances/${id}/sessions`);
      setSession(r.session);
      setTakenOver(false);
      setViewer({ state: 'connecting', attempt: 0 });
      void queryClient.invalidateQueries({ queryKey: keys.instance(id) });
    } catch (e) {
      setOpenError(e);
    }
  }, [id]);

  useEffect(() => {
    void open();
  }, [open]);

  // End the viewer session when leaving the page.
  useEffect(() => {
    if (!session) return;
    const end = () => void fetch(`/api/v1/sessions/${session.id}/end`, { method: 'POST', keepalive: true, credentials: 'same-origin' });
    window.addEventListener('pagehide', end);
    return () => {
      window.removeEventListener('pagehide', end);
      end();
    };
  }, [session]);

  const status = instance.data?.status;

  // Heartbeats carry whether the user interacted, which drives the idle timeout.
  useEffect(() => {
    if (!session || takenOver) return;
    const beat = async () => {
      try {
        const r = await api<HeartbeatResult>('POST', `/sessions/${session.id}/heartbeat`, { body: { input: hadInput.current } });
        hadInput.current = false;
        setSleepAt(r.sleepAt ? Date.parse(r.sleepAt) : null);
        setSleepReason(r.reason ?? 'idle');
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) setTakenOver(true);
      }
    };
    void beat();
    const h = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(h);
  }, [session, takenOver, status]);

  // Out of credit, or the free trial ending: say so once, while there is still time to finish up (page 6).
  const toast = useToast();
  useEffect(() => {
    if (sleepReason === 'idle' || !sleepAt) return;
    const minutes = Math.max(1, Math.round((sleepAt - Date.now()) / 60_000));
    toast(t(sleepReason === 'balance' ? 'session.balanceOut' : 'session.trialOut', { minutes }), 'error');
  }, [sleepReason]);

  useEffect(() => {
    if (!sleepAt) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [sleepAt]);

  const connect = useQuery({
    queryKey: ['connect', session?.id],
    enabled: !!session && !takenOver && status === 'running',
    queryFn: () => api<ConnectInfo>('GET', `/sessions/${session!.id}/connect`),
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!keyboardOpen) {
      setVisibleHeight(null);
      return;
    }
    const viewport = window.visualViewport;
    const resize = () => setVisibleHeight(viewport?.height ?? window.innerHeight);
    resize();
    viewport?.addEventListener('resize', resize);
    window.addEventListener('resize', resize);
    return () => {
      viewport?.removeEventListener('resize', resize);
      window.removeEventListener('resize', resize);
    };
  }, [keyboardOpen]);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await frameRef.current?.requestFullscreen();
    // Lets Ctrl+W, T, N and Tab reach the remote browser in fullscreen (page 5).
    const kb = (navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void> } }).keyboard;
    await kb?.lock?.().catch(() => {});
  };

  const stayAwake = () => {
    hadInput.current = true;
    if (session) {
      void api<HeartbeatResult>('POST', `/sessions/${session.id}/heartbeat`, { body: { input: true } })
        .then((r) => {
          setSleepAt(r.sleepAt ? Date.parse(r.sleepAt) : null);
          setSleepReason(r.reason ?? 'idle');
        })
        .catch(() => {});
    }
  };

  const i = instance.data;
  const region = i ? regionInfo(i.regionId) : null;
  const regionName = i ? t(`create.region.${i.regionId}`) : '';
  const idleLeft = sleepAt ? sleepAt - now : Infinity;

  let overlay: ReactNode = null;
  if (instance.isError) {
    overlay = <Overlay message={errorMessage(instance.error)} action={<Button onClick={() => navigate('/browsers')}>{t('session.back')}</Button>} />;
  } else if (takenOver || viewer.state === 'taken-over') {
    overlay = <Overlay message={t('overlay.elsewhere')} action={<Button variant="primary" onClick={() => void open()}>{t('overlay.useHere')}</Button>} />;
  } else if (openError && status !== 'running') {
    overlay = <Overlay message={errorMessage(openError)} action={<Button onClick={() => void open()}>{t('common.retry')}</Button>} />;
  } else if (i) {
    switch (i.status) {
      case 'creating':
        overlay = <Overlay message={t('overlay.creating')} body={<CreateProgress instance={i} tone="dark" />} />;
        break;
      case 'starting':
        overlay = <Overlay message={t('overlay.waking')} body={<p className="text-sm text-zinc-400">{t('overlay.wakingHint')}</p>} busy />;
        break;
      case 'stopping':
        overlay = <Overlay message={t('status.stopping')} busy />;
        break;
      case 'sleeping':
        overlay = <Overlay message={t('overlay.asleep')} action={<Button variant="primary" onClick={() => void open()}>{t('overlay.wake')}</Button>} />;
        break;
      case 'waiting_capacity':
        overlay = <Overlay message={t('overlay.capacity', { region: regionName })} />;
        break;
      case 'provider_issue':
        overlay = <Overlay message={t('overlay.provider', { region: regionName })} />;
        break;
      case 'needs_attention':
        overlay =
          i.lastIpCheck && !i.lastIpCheck.ok ? (
            <Overlay
              message={t('overlay.networkPaused')}
              action={
                <Button disabled={verify.isPending} onClick={() => verify.mutate(i.id)}>
                  {t('overlay.checkStatus')}
                </Button>
              }
            />
          ) : (
            <Overlay
              message={t('overlay.error', { reason: i.statusReason ?? '' })}
              body={<p className="font-mono text-xs text-zinc-500">{i.id}</p>}
              action={
                <Button disabled={lifecycle.isPending} onClick={() => lifecycle.mutate({ id: i.id, action: 'start' })}>
                  {t('overlay.restart')}
                </Button>
              }
            />
          );
        break;
      case 'failed':
        overlay = <Overlay message={t('overlay.failed', { reason: i.statusReason ?? '' })} action={<Button onClick={() => navigate('/browsers')}>{t('session.back')}</Button>} />;
        break;
      case 'deleting':
      case 'purged':
        overlay = <Overlay message={t('overlay.deleted')} action={<Button onClick={() => navigate('/browsers')}>{t('session.back')}</Button>} />;
        break;
      case 'running':
        if (connect.data?.mode === 'webrtc' && viewer.state === 'reconnecting') {
          overlay = (
            <Overlay
              message={t('overlay.reconnecting', { attempt: viewer.attempt })}
              busy
              action={<Button onClick={() => viewerRef.current?.reconnect()}>{t('overlay.retryNow')}</Button>}
            />
          );
        } else if (connect.data?.mode === 'webrtc' && (viewer.state === 'connecting' || viewer.state === 'agent-offline')) {
          overlay = <Overlay message={t('overlay.connecting')} busy />;
        } else if (sleepReason !== 'idle' && idleLeft < IDLE_WARNING_MS) {
          const seconds = Math.max(0, Math.ceil(idleLeft / 1000));
          overlay = <Overlay message={t(sleepReason === 'balance' ? 'overlay.balanceEnding' : 'overlay.trialEnding', { seconds })} />;
        } else if (idleLeft < IDLE_WARNING_MS) {
          overlay = (
            <Overlay
              message={t('overlay.idle', { seconds: Math.max(0, Math.ceil(idleLeft / 1000)) })}
              action={
                <Button variant="primary" onClick={stayAwake}>
                  {t('overlay.stayAwake')}
                </Button>
              }
            />
          );
        }
        break;
    }
  }

  const live = i?.status === 'running' && connect.data?.mode === 'webrtc' && viewer.state === 'live';

  const disabledTool = (label: string, Icon: typeof Upload) => (
    <Button key={label} size="icon" variant="ghost" className="text-zinc-300 hover:bg-zinc-800" disabled aria-label={label} title={`${label} · ${t('session.needsStream')}`}>
      <Icon />
    </Button>
  );

  return (
    <div ref={frameRef} className="flex h-dvh flex-col bg-frame text-zinc-100" style={visibleHeight === null ? undefined : { height: visibleHeight }}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-800 px-2">
        <Button size="icon" variant="ghost" className="text-zinc-300 hover:bg-zinc-800" aria-label={t('session.back')} onClick={() => navigate('/browsers')}>
          <ArrowLeft />
        </Button>
        <span className="max-w-48 truncate font-medium">{i?.name ?? '…'}</span>
        {i && region ? (
          <RegionIpChip
            tone="dark"
            className="hidden sm:inline-flex"
            country={region.country}
            city={region.city}
            ip={i.ipAddress}
            dedicatedLabel={t('browsers.dedicated')}
            copyLabel={t('browsers.copyIp')}
            pendingLabel={t('browsers.reservingIp')}
          />
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          {i && i.status !== 'running' ? (
            <StatusBadge className="mr-2 hidden text-zinc-300 md:inline-flex" tone={STATUS_TONE[i.status]} label={t(statusKey(i.status))} />
          ) : connect.data?.mode === 'webrtc' && stats ? (
            <ConnectionIndicator stats={stats} />
          ) : connect.data?.mode === 'simulated' ? (
            <span className="mr-2 hidden items-center gap-1.5 text-xs text-zinc-400 md:inline-flex" title={t('session.simulatedHint')}>
              <span className="size-2 rounded-full bg-starting" aria-hidden /> {t('session.simulated')}
            </span>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            className="text-zinc-300 hover:bg-zinc-800"
            disabled={!live}
            aria-label={t(keyboardOpen ? 'session.hideKeyboard' : 'session.showKeyboard')}
            title={t(keyboardOpen ? 'session.hideKeyboard' : 'session.showKeyboard')}
            aria-pressed={keyboardOpen}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => viewerRef.current?.toggleKeyboard()}
          >
            <Keyboard />
          </Button>
          <div className="hidden items-center gap-0.5 sm:flex">
            {live ? (
              <Button
                size="icon"
                variant="ghost"
                className="text-zinc-300 hover:bg-zinc-800"
                aria-label={t('session.pasteLocal')}
                title={t('session.pasteLocal')}
                onClick={async () => {
                  const text = await navigator.clipboard?.readText().catch(() => '');
                  if (text) viewerRef.current?.paste(text);
                  viewerRef.current?.focus();
                }}
              >
                <ClipboardCopy />
              </Button>
            ) : (
              disabledTool(t('session.clipboard'), ClipboardCopy)
            )}
            {disabledTool(t('session.upload'), Upload)}
            {disabledTool(t('session.downloads'), Download)}
            {live ? (
              <Menu
                trigger={
                  <Button size="icon" variant="ghost" className="text-zinc-300 hover:bg-zinc-800" aria-label={t('session.keys')} title={t('session.keys')}>
                    <Command />
                  </Button>
                }
              >
                {Object.entries(COMBOS).map(([label, names]) => (
                  <MenuItem
                    key={label}
                    onSelect={() => {
                      viewerRef.current?.sendCombo(names);
                      viewerRef.current?.focus();
                    }}
                  >
                    <span className="font-mono text-xs">{label}</span>
                  </MenuItem>
                ))}
              </Menu>
            ) : (
              disabledTool(t('session.keys'), Keyboard)
            )}
            {disabledTool(t('session.quality'), Gauge)}
            {live ? (
              <Button
                size="icon"
                variant="ghost"
                className="text-zinc-300 hover:bg-zinc-800"
                aria-label={t('session.sound')}
                title={t('session.sound')}
                aria-pressed={!muted}
                onClick={() => setMuted((m) => !m)}
              >
                {muted ? <VolumeX /> : <Volume2 />}
              </Button>
            ) : (
              disabledTool(t('session.sound'), Volume2)
            )}
          </div>
          <Button size="icon" variant="ghost" className="text-zinc-300 hover:bg-zinc-800" aria-label={t('session.fullscreen')} title={t('session.fullscreen')} onClick={() => void toggleFullscreen()}>
            {fullscreen ? <Minimize /> : <Maximize />}
          </Button>
          <Menu
            trigger={
              <Button size="icon" variant="ghost" className="text-zinc-300 hover:bg-zinc-800" aria-label={t('session.more')}>
                <MoreHorizontal />
              </Button>
            }
          >
            <MenuItem disabled={!i || !['needs_attention'].includes(i.status)} onSelect={() => i && lifecycle.mutate({ id: i.id, action: 'start' })}>
              <RotateCw /> {t('overlay.restart')}
            </MenuItem>
            <MenuItem disabled={i?.status !== 'running'} onSelect={() => i && lifecycle.mutate({ id: i.id, action: 'stop' })}>
              <Moon /> {t('browsers.sleepNow')}
            </MenuItem>
            <MenuItem onSelect={() => navigate(`/browsers/${id}/settings`)}>
              <Settings /> {t('browsers.settings')}
            </MenuItem>
          </Menu>
        </div>
      </header>

      <div
        className="relative min-h-0 flex-1"
        onPointerDown={() => (hadInput.current = true)}
        onKeyDown={() => (hadInput.current = true)}
        onWheel={() => (hadInput.current = true)}
      >
        {i?.status === 'running' && connect.data?.mode === 'simulated' ? <SimulatedChrome instance={i} regionName={regionName} /> : null}
        {i?.status === 'running' && connect.data?.mode === 'webrtc' && session && !takenOver ? (
          <RemoteBrowserView
            key={session.id}
            ref={viewerRef}
            className="absolute inset-0 bg-frame"
            muted={muted}
            // Each viewer token works once, so every (re)connect asks the api for a fresh one.
            getConnectInfo={async () => {
              const c = await api<ConnectInfo>('GET', `/sessions/${session.id}/connect`);
              if (c.mode !== 'webrtc') throw new Error('live view unavailable');
              return c;
            }}
            onState={(state, attempt) => setViewer({ state, attempt })}
            onStats={setStats}
            onInput={() => (hadInput.current = true)}
            onKeyboardChange={setKeyboardOpen}
          />
        ) : null}
        {i?.status === 'running' && connect.isError ? <Overlay message={errorMessage(connect.error)} /> : null}
        {overlay}
      </div>
    </div>
  );
}

/** ● 32 ms, colored by quality; details on hover (page 5, "Quality telemetry"). */
function ConnectionIndicator({ stats }: { stats: ViewerStats }) {
  const level = qualityLevel(stats);
  const color = { good: 'bg-running', fair: 'bg-starting', poor: 'bg-error', unknown: 'bg-sleeping' }[level];
  const details = [
    stats.rttMs !== null ? `RTT ${stats.rttMs} ms` : null,
    stats.fps !== null ? `${stats.fps} fps` : null,
    stats.loss !== null ? `loss ${(stats.loss * 100).toFixed(1)}%` : null,
    stats.bitrateKbps !== null ? `${stats.bitrateKbps} kbps` : null,
    stats.codec,
    stats.transport,
    stats.width && stats.height ? `${stats.width}×${stats.height}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className="mr-2 hidden items-center gap-1.5 font-mono text-xs text-zinc-300 md:inline-flex" title={details} data-testid="connection-indicator">
      <span className={cn('size-2 rounded-full', color)} aria-hidden />
      {stats.rttMs !== null ? `${stats.rttMs} ms` : '—'}
      {stats.fps !== null ? <span className="text-zinc-500">· {stats.fps} fps</span> : null}
    </span>
  );
}

function Overlay({ message, body, action, busy }: { message: string; body?: ReactNode; action?: ReactNode; busy?: boolean }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-frame/80 p-4">
      <div role="status" className="w-full max-w-md rounded-[var(--radius-card)] border border-zinc-800 bg-zinc-900 p-6 text-center shadow-xl">
        {busy ? <div className="mx-auto mb-4 size-6 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-200" aria-hidden /> : null}
        <p className="text-base leading-relaxed text-zinc-100">{message}</p>
        {body ? <div className="mt-4 flex justify-center text-left">{body}</div> : null}
        {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

/** Placeholder for the stream while the browser runs on the fake executor. */
function SimulatedChrome({ instance, regionName }: { instance: Instance; regionName: string }) {
  const { t } = useI18n();
  const [focused, setFocused] = useState(false);
  return (
    <div
      tabIndex={0}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={cn('absolute inset-0 flex flex-col bg-white text-zinc-900 outline-none', !focused && 'cursor-pointer')}
      aria-label={t('session.fakeTitle')}
    >
      <div className="flex h-9 items-end gap-1 bg-zinc-200 px-2">
        <div className="flex h-7 w-52 items-center rounded-t-lg bg-white px-3 text-xs">{t('session.fakeTitle')}</div>
      </div>
      <div className="flex h-9 items-center gap-2 border-b border-zinc-200 px-3">
        <span className="text-zinc-400">← → ⟳</span>
        <div className="h-6 flex-1 rounded-full bg-zinc-100 px-3 font-mono text-xs leading-6 text-zinc-500">chrome://newtab</div>
      </div>
      <div className="grid flex-1 place-items-center p-6">
        <div className="max-w-lg text-center">
          <p className="text-lg font-semibold">{t('session.fakeTitle')}</p>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">{t('session.fakeBody')}</p>
          <p className="mt-4 text-sm">{t('session.fakeIp', { ip: instance.ipAddress ?? '—', region: regionName })}</p>
          {!focused ? <p className="mt-6 text-xs text-zinc-400">{t('session.focusHint')}</p> : null}
          <p className="mt-6 text-xs text-zinc-400">
            <Link to={`/browsers/${instance.id}/settings`} className="underline">
              {t('browsers.settings')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
