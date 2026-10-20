import { useRegionInfo } from '../instances/hooks.js';
import type { ConnectInfo, Instance, VideoQuality, ViewerSession } from '@cloudbrowser/contracts';
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
  RotateCwSquare,
  Settings,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { COMBOS, qualityLevel, type TransferUpdate, type ViewerState, type ViewerStats } from '@cloudbrowser/viewer';
import { RemoteBrowserView, type RemoteBrowserHandle } from '@cloudbrowser/viewer/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import type { MessageKey } from '../../messages/en.js';
import { keys, queryClient } from '../../lib/query.js';
import { CreateProgress } from '../instances/CreateProgress.js';
import { useInstance, useLifecycle, useVerifyIp } from '../instances/hooks.js';
import { shownStatus, STATUS_TONE, statusKey } from '../instances/status.js';

const HEARTBEAT_MS = 15_000;
const IDLE_WARNING_MS = 60_000;
const SESSION_REQUEST_TIMEOUT_MS = 20_000;
/** Viewer tokens expire 60 s after issue; a prefetched one is handed over only while well inside that. */
const PREFETCHED_TOKEN_MAX_AGE_MS = 30_000;

/** Bound session creation and token fetches too; a transport deadline starts after them. */
async function sessionRequest<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SESSION_REQUEST_TIMEOUT_MS);
  try {
    return await api<T>(method, path, { body, idempotencyKey, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) throw new ApiError(408, {
      type: 'internal', title: 'Connection timed out', status: 408,
      detail: 'The browser connection request timed out. Please retry.',
    });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

type HeartbeatResult = { sleepAt: string | null; reason?: 'idle' | 'balance' | 'trial' };

/**
 * Live session (`/b/:id`, page 1 and page 5). The dark frame keeps attention on the remote page.
 * While browsers run on the fake executor the stream area shows a simulated Chrome; the real
 * viewer (packages/viewer, neko over the gateway) plugs into the same shell.
 */
const ROTATED_KEY = 'cb.session.rotated';
/** A transfer this large says it is under way; smaller ones finish before a toast could be read. */
const LARGE_TRANSFER_BYTES = 2 * 1024 * 1024;
const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function SessionPage() {
  const { id = '' } = useParams();
  const { t, errorMessage } = useI18n();
  const connectionErrorMessage = (error: unknown) => error instanceof ApiError && error.status === 408 ? t('error.connection_timeout') : errorMessage(error);
  const navigate = useNavigate();
  const instance = useInstance(id);
  const lifecycle = useLifecycle();
  const verify = useVerifyIp();
  const frameRef = useRef<HTMLDivElement>(null);
  const hadInput = useRef(false);

  const [session, setSession] = useState<ViewerSession | null>(null);
  const [openError, setOpenError] = useState<unknown>(null);
  const [connectionError, setConnectionError] = useState<unknown>(null);
  const [takenOver, setTakenOver] = useState(false);
  const [sleepAt, setSleepAt] = useState<number | null>(null);
  /** `balance`: the prepaid balance ran out; input does not keep the browser awake. */
  const [sleepReason, setSleepReason] = useState<'idle' | 'balance' | 'trial'>('idle');
  const [now, setNow] = useState(Date.now());
  const [fullscreen, setFullscreen] = useState(false);
  const viewerRef = useRef<RemoteBrowserHandle>(null);
  const [viewer, setViewer] = useState<{ state: ViewerState; attempt: number }>({ state: 'connecting', attempt: 0 });
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [streaming, setStreaming] = useState<VideoQuality | null>(null);
  const [muted, setMuted] = useState(true);
  // Phones only: the view turned a quarter for a phone held sideways (a remembered preference).
  const [touchDevice] = useState(() => typeof window !== 'undefined' && navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches);
  const [rotated, setRotated] = useState(() => {
    try { return touchDevice && localStorage.getItem(ROTATED_KEY) === '1'; } catch { return false; }
  });
  const uploadRef = useRef<HTMLInputElement>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [inputInterrupted, setInputInterrupted] = useState(false);
  /** While the on-screen keyboard is up: the part of the page left visible above it. */
  const [visibleArea, setVisibleArea] = useState<{ top: number; height: number } | null>(null);
  const openRequest = useRef<{ instanceId: string; promise: Promise<void> } | null>(null);
  const openIntent = useRef<{ instanceId: string; key: string } | null>(null);
  const openSequence = useRef(0);
  const connectRequestSequence = useRef(0);
  /** The prefetched single-use token already given to the viewer; each token is handed out once. */
  const handedOutToken = useRef<string | null>(null);
  const currentInstanceId = useRef(id);
  currentInstanceId.current = id;
  const currentSessionId = useRef(session?.id);
  currentSessionId.current = session?.id;

  const open = useCallback((newIntent = false) => {
    // StrictMode effects and repeated Retry / Use here clicks must share a request.
    // Creating two sessions would make this page revoke its own first session.
    if (openRequest.current?.instanceId === id) return openRequest.current.promise;
    if (newIntent || openIntent.current?.instanceId !== id) openIntent.current = { instanceId: id, key: crypto.randomUUID() };
    const intent = openIntent.current;
    const sequence = ++openSequence.current;
    setOpenError(null);
    setConnectionError(null);
    const request = { instanceId: id, promise: Promise.resolve() };
    request.promise = (async () => {
      try {
        const r = await sessionRequest<{ session: ViewerSession; operationId: string | null }>('POST', `/instances/${id}/sessions`, undefined, intent.key);
        if (sequence !== openSequence.current || currentInstanceId.current !== id) return;
        if (openIntent.current === intent) openIntent.current = null;
        setSession(r.session);
        setTakenOver(false);
        setInputInterrupted(false);
        setSleepAt(null);
        setSleepReason('idle');
        setViewer({ state: 'connecting', attempt: 0 });
        void queryClient.invalidateQueries({ queryKey: keys.instance(id) });
      } catch (e) {
        // A timeout or unknown server/network result may already have opened the session.
        // Retry that same intent; a definite rejection lets the next explicit retry be new.
        if (e instanceof ApiError && e.status < 500 && e.status !== 408 && openIntent.current === intent) openIntent.current = null;
        if (sequence === openSequence.current && currentInstanceId.current === id) setOpenError(e);
      } finally {
        if (openRequest.current === request) openRequest.current = null;
      }
    })();
    openRequest.current = request;
    return request.promise;
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
    let active = true;
    let inFlight = false;
    const beat = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      const input = hadInput.current;
      hadInput.current = false;
      try {
        const r = await api<HeartbeatResult>('POST', `/sessions/${session.id}/heartbeat`, { body: { input } });
        if (!active) return;
        setSleepAt(r.sleepAt ? Date.parse(r.sleepAt) : null);
        setSleepReason(r.reason ?? 'idle');
      } catch (e) {
        if (!active) return;
        hadInput.current ||= input;
        if (e instanceof ApiError && e.status === 409) setTakenOver(true);
        else if (e instanceof ApiError && [401, 402, 403, 404].includes(e.status)) setOpenError(e);
      } finally {
        inFlight = false;
      }
    };
    void beat();
    const h = setInterval(beat, HEARTBEAT_MS);
    return () => {
      active = false;
      clearInterval(h);
    };
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
    queryFn: () => sessionRequest<ConnectInfo>('GET', `/sessions/${session!.id}/connect`),
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // The page follows the visual viewport while the keyboard is up, so the remote screen moves up
  // and shrinks into the space above it instead of being covered. The remote screen keeps its size
  // (the viewer stops resizing it while typing), so the picture scales down proportionally.
  useEffect(() => {
    if (!keyboardOpen) {
      setVisibleArea(null);
      // iOS can leave the page panned after the keyboard closes.
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
      return;
    }
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = Math.round(viewport?.height ?? window.innerHeight);
        // iOS pans the layout viewport to keep the focused field in view; follow the pan.
        const top = Math.max(0, Math.round(viewport?.offsetTop ?? 0));
        setVisibleArea((prev) => (prev?.top === top && prev.height === height ? prev : { top, height }));
      });
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
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
  const region = useRegionInfo(i?.regionId ?? '');
  const regionName = region.name;
  const idleLeft = sleepAt ? sleepAt - now : Infinity;

  let overlay: ReactNode = null;
  if (instance.isError) {
    overlay = <Overlay message={errorMessage(instance.error)} action={<Button onClick={() => navigate('/browsers')}>{t('session.back')}</Button>} />;
  } else if (takenOver || viewer.state === 'taken-over') {
    overlay = <Overlay message={t('overlay.elsewhere')} action={<Button variant="primary" onClick={() => void open(true)}>{t('overlay.useHere')}</Button>} />;
  } else if (inputInterrupted) {
    overlay = <Overlay message={t('overlay.inputInterrupted')} action={<Button onClick={() => {
      setInputInterrupted(false);
      viewerRef.current?.reconnect();
    }}>{t('overlay.retryNow')}</Button>} />;
  } else if (openError || connectionError) {
    overlay = <Overlay message={connectionErrorMessage(openError ?? connectionError)} action={<Button onClick={() => void open()}>{t('common.retry')}</Button>} />;
  } else if (i) {
    switch (shownStatus(i)) {
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
        overlay = <Overlay message={i.stopReason ? t(`browsers.stopped.${i.stopReason}` as MessageKey) : t('overlay.asleep')} action={<Button variant="primary" onClick={() => void open()}>{t('overlay.wake')}</Button>} />;
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
        } else if (connect.data?.mode === 'webrtc' && viewer.state === 'agent-offline') {
          overlay = <Overlay message={t('overlay.agentOffline')} busy action={<Button onClick={() => viewerRef.current?.reconnect()}>{t('overlay.retryNow')}</Button>} />;
        } else if (connect.data?.mode === 'webrtc' && viewer.state === 'connecting') {
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

  const toggleRotated = () => {
    const next = !rotated;
    setRotated(next);
    try { localStorage.setItem(ROTATED_KEY, next ? '1' : '0'); } catch { /* Not remembered. */ }
    viewerRef.current?.focus();
  };

  const onTransfer = (update: TransferUpdate) => {
    if (update.state === 'uploading' && update.bytes >= LARGE_TRANSFER_BYTES) toast(t('session.fileSending', { size: formatBytes(update.bytes) }));
    if (update.state !== 'error') return;
    const key: MessageKey = { too_large: 'session.fileTooLarge', too_many: 'session.fileTooMany', not_on_page: 'session.fileNotOnPage', unsupported: 'session.fileUnsupported', timeout: 'session.fileUnsupported' }[update.reason ?? ''] as MessageKey | undefined ?? 'session.fileFailed';
    toast(t(key), 'error');
  };

  const disabledTool = (label: string, Icon: typeof Upload) => (
    <Button key={label} size="icon" variant="ghost" className="text-zinc-300 hover:bg-zinc-800" disabled aria-label={label} title={`${label} · ${t('session.needsStream')}`}>
      <Icon />
    </Button>
  );

  return (
    <div ref={frameRef} className="cb-dark fixed inset-0 flex h-dvh flex-col overflow-hidden overscroll-none bg-frame text-zinc-100" style={visibleArea === null ? undefined : { top: visibleArea.top, bottom: 'auto', height: visibleArea.height }}>
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
            <StatusBadge className="mr-2 hidden text-zinc-300 md:inline-flex" tone={STATUS_TONE[shownStatus(i)]} label={t(statusKey(shownStatus(i)))} />
          ) : connect.data?.mode === 'webrtc' && stats ? (
            <ConnectionIndicator stats={stats} picture={streaming ? t(`session.picture.${streaming}` as MessageKey) : null} />
          ) : connect.data?.mode === 'simulated' ? (
            <span className="mr-2 hidden items-center gap-1.5 text-xs text-zinc-400 md:inline-flex" title={t('session.simulatedHint')}>
              <span className="size-2 rounded-full bg-starting" aria-hidden /> {t('session.simulated')}
            </span>
          ) : null}
          {touchDevice ? (
            <Button
              size="icon"
              variant="ghost"
              className="text-zinc-300 hover:bg-zinc-800"
              aria-label={t('session.rotate')}
              title={t('session.rotate')}
              aria-pressed={rotated}
              onClick={toggleRotated}
            >
              <RotateCwSquare />
            </Button>
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
            onMouseDown={(e) => e.preventDefault()}
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
            {live ? (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-zinc-300 hover:bg-zinc-800"
                  aria-label={t('session.uploadFiles')}
                  title={t('session.uploadFiles')}
                  onClick={() => uploadRef.current?.click()}
                >
                  <Upload />
                </Button>
                <input
                  ref={uploadRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = [...(e.currentTarget.files ?? [])];
                    e.currentTarget.value = '';
                    viewerRef.current?.pasteFiles(files);
                    viewerRef.current?.focus();
                  }}
                />
              </>
            ) : (
              disabledTool(t('session.upload'), Upload)
            )}
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
            onInputError={() => setInputInterrupted(true)}
            onTransfer={onTransfer}
            rotated={rotated}
            className="absolute inset-0 bg-frame"
            muted={muted}
            // Each viewer token works once, so every (re)connect asks the api for a fresh one.
            getConnectInfo={async () => {
              const sequence = ++connectRequestSequence.current;
              // The page fetched one token to learn the live-view mode. The first attempt uses it
              // instead of waiting for a second token; retries always fetch a fresh one.
              const prefetched = connect.data;
              if (prefetched?.mode === 'webrtc' && handedOutToken.current !== prefetched.token
                && Date.now() - connect.dataUpdatedAt < PREFETCHED_TOKEN_MAX_AGE_MS) {
                handedOutToken.current = prefetched.token;
                return prefetched;
              }
              try {
                const c = await sessionRequest<ConnectInfo>('GET', `/sessions/${session.id}/connect`);
                if (c.mode !== 'webrtc') throw new Error('live view unavailable');
                if (currentSessionId.current === session.id && sequence === connectRequestSequence.current) setConnectionError(null);
                return c;
              } catch (e) {
                if (currentSessionId.current === session.id && sequence === connectRequestSequence.current) setConnectionError(e);
                throw e;
              }
            }}
            onState={(state, attempt) => setViewer({ state, attempt })}
            onStats={setStats}
            onVideo={setStreaming}
            onInput={() => (hadInput.current = true)}
            onKeyboardChange={setKeyboardOpen}
          />
        ) : null}
        {i?.status === 'running' && connect.isError ? <Overlay message={connectionErrorMessage(connect.error)} action={<Button onClick={() => void connect.refetch()}>{t('common.retry')}</Button>} /> : null}
        {overlay}
      </div>
    </div>
  );
}

/** ● 32 ms, colored by quality; details on hover (page 5, "Quality telemetry"). */
function ConnectionIndicator({ stats, picture }: { stats: ViewerStats; picture: string | null }) {
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
    picture,
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
      <div role="status" className="w-full max-w-md border border-zinc-700 bg-zinc-950 p-8 text-center">
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
