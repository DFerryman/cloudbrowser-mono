import { useRegionInfo } from '../instances/hooks.js';
import { STREAM, TIERS, type AgentControlMode, type ConnectionDiagnostic, type ConnectInfo, type Instance, type VideoQuality, type ViewerSession } from '@cloudbrowser/contracts';
import { Button, cn, Menu, MenuItem, MenuLabel, MenuSeparator, RegionIpChip, StatusBadge, useToast } from '@cloudbrowser/ui';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bot,
  Bug,
  ClipboardCopy,
  Command,
  Download,
  Eye,
  EyeOff,
  Gauge,
  Hand,
  Keyboard,
  Maximize,
  Minimize,
  Moon,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCw,
  RotateCwSquare,
  Settings,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { COMBOS, qualityLevel, type AutomationStatus, type ConnectionIssue, type TransferUpdate, type ViewerState, type ViewerStats } from '@cloudbrowser/viewer';
import { RemoteBrowserView, type RemoteBrowserHandle } from '@cloudbrowser/viewer/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import type { MessageKey } from '../../messages/en.js';
import { keys, queryClient } from '../../lib/query.js';
import { CreateProgress } from '../instances/CreateProgress.js';
import { useInstance, useLifecycle, useSetControl, useVerifyIp } from '../instances/hooks.js';
import { shownStatus, STATUS_TONE, statusKey } from '../instances/status.js';
import { useRegionLatency } from '../instances/latency.js';
import { connectionDiagnosticReporter, liveQualityReporter } from './diagnostics.js';
import { sessionHeartbeat, viewingPresence } from './heartbeat.js';

/** Whether this web browser decodes H.264 over WebRTC, which the live view needs. Unknown counts as yes. */
const decodesH264 = (() => {
  try {
    const codecs = globalThis.RTCRtpReceiver?.getCapabilities?.('video')?.codecs;
    return !codecs || codecs.some((c) => c.mimeType.toLowerCase() === 'video/h264');
  } catch {
    return true;
  }
})();

const IDLE_WARNING_MS = 60_000;
/** How long a change of who drives the browser is announced over the picture. */
const AGENT_NOTICE_MS = 5_000;
/** iOS can leave the page panned after the on-screen keyboard closes; the page is put back once more after its closing animation. */
const KEYBOARD_CLOSE_SETTLE_MS = 500;
/** iPhone and iPad, including an iPad presenting itself as a Mac. */
const appleTouch = () => /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/**
 * Maximize within the page rather than with the Fullscreen API: WebKit allows no keyboard input
 * while an element is fullscreen on iPhone and iPad (an on-screen keyboard never opens there),
 * phones and tablets handle the on-screen keyboard the same way in either, and some browsers have
 * no element fullscreen at all. Desktops, touch screens included, keep true fullscreen with Keyboard Lock.
 */
const maximizesInPage = () => typeof document === 'undefined' || appleTouch() || window.matchMedia('(pointer: coarse)').matches
  || !document.fullscreenEnabled || typeof HTMLElement.prototype.requestFullscreen !== 'function';
const SESSION_REQUEST_TIMEOUT_MS = 20_000;
/** Drops the user's network caused within this window, at least UNSTABLE_DROPS of them, mean it is unstable rather than unlucky. */
const UNSTABLE_WINDOW_MS = 5 * 60_000;
const UNSTABLE_DROPS = 3;
/** A round trip slower than this for SLOW_READINGS stats readings in a row (2 s each) is worth a word. */
const SLOW_RTT_MS = 250;
const SLOW_READINGS = 3;
/**
 * The picture's round trip against the user's own to the browser's region (as web pages travel):
 * this much more, and at least twice it, means the picture takes another way. A VPN or proxy
 * carries the page but not the video (WebRTC over UDP), and from mainland China the relay is
 * reached in the US.
 */
const DETOUR_MIN_RTT_MS = 150;
const DETOUR_EXTRA_MS = 100;
const detour = (rtt: number, region: number) => rtt >= DETOUR_MIN_RTT_MS && rtt >= 2 * region && rtt - region >= DETOUR_EXTRA_MS;
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

type HeartbeatResult = { sleepAt: string | null; reason?: 'idle' | 'balance' };

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
  const [inputInterrupted, setInputInterrupted] = useState(false);
  /** Why input delivery was interrupted, when the viewer could tell. */
  const [inputIssue, setInputIssue] = useState<ConnectionIssue | null>(null);
  const [sleepAt, setSleepAt] = useState<number | null>(null);
  /** `balance`: the prepaid balance ran out; input does not keep the browser awake. */
  const [sleepReason, setSleepReason] = useState<'idle' | 'balance'>('idle');
  const [now, setNow] = useState(Date.now());
  const [fullscreen, setFullscreen] = useState(false);
  /** Maximized within the page: the toolbar gives way to the picture and a small floating control. */
  const [maximized, setMaximized] = useState(false);
  /** Any touch screen, an iPad with a trackpad included: the on-screen keyboard and the visual viewport behave the same. */
  const [touchScreen] = useState(() => typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
  const viewerRef = useRef<RemoteBrowserHandle>(null);
  const [viewer, setViewer] = useState<{ state: ViewerState; attempt: number; issue: ConnectionIssue | null }>({ state: 'connecting', attempt: 0, issue: null });
  /** When the user's network dropped a live view lately (UNSTABLE_WINDOW_MS), and how many times. */
  const networkDrops = useRef<number[]>([]);
  const lastViewerState = useRef<ViewerState>('connecting');
  const [unstableDrops, setUnstableDrops] = useState(0);
  /**
   * A sustained slow round trip (ms), told once until the user dismisses it; `region`: the user's
   * own round trip to the browser's region, when the picture's is far longer (detour).
   */
  const slowReadings = useRef(0);
  const [slowRtt, setSlowRtt] = useState<{ rtt: number; region: number | null } | null>(null);
  const regionRtt = useRef<number | null>(null);
  const [slowDismissed, setSlowDismissed] = useState(false);
  const heartbeat = useRef<ReturnType<typeof sessionHeartbeat<HeartbeatResult>> | null>(null);
  // Effect recreation (including StrictMode) must never reuse a sequence for this session.
  const presenceSequence = useRef(0);
  const presenceContext = useRef({ running: false, live: false, takenOver: false });
  // Input that may have been lost ended the connection (the viewer's inputFailed): the notice is
  // not a watched desktop, so it lets the browser's idle countdown start.
  presenceContext.current = { running: instance.data?.status === 'running', live: viewer.state === 'live' && !inputInterrupted, takenOver };
  const [diagnosticId, setDiagnosticId] = useState<string | null>(null);
  const diagnostics = useRef<{ sessionId: string; reporter: ReturnType<typeof connectionDiagnosticReporter> } | null>(null);
  const pendingDiagnostics = useRef<{ sessionId: string; diagnostic: ConnectionDiagnostic }[]>([]);
  const quality = useRef<{ sessionId: string; reporter: ReturnType<typeof liveQualityReporter> } | null>(null);
  useEffect(() => {
    if (!session) return;
    const current = { sessionId: session.id, reporter: liveQualityReporter(session.id) };
    quality.current = current;
    // The view's last report comes after this cleanup (React cleans up the page before the view
    // below it): the reporter stays in place to take it, and refuses reports once disposed.
    return () => current.reporter.dispose();
  }, [session?.id]);
  useEffect(() => {
    if (!session) return;
    const current = { sessionId: session.id, reporter: connectionDiagnosticReporter(session.id) };
    diagnostics.current = current;
    // Child effects can start an attempt before this parent effect, including in StrictMode.
    for (const pending of pendingDiagnostics.current.splice(0)) {
      if (pending.sessionId === session.id) current.reporter.report(pending.diagnostic);
    }
    return () => {
      current.reporter.dispose();
      if (diagnostics.current === current) diagnostics.current = null;
    };
  }, [session?.id]);
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
  // A coding agent's session (docs/agent-access.md): shown while one is open; the user's own
  // click takes control, and the banner is where control is handed back or screenshots paused.
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const setControl = useSetControl();
  /** On a touch screen: the visible part of the page (the visual viewport), in page coordinates; the frame is laid out exactly there. */
  const [visibleArea, setVisibleArea] = useState<{ top: number; left: number; width: number; height: number } | null>(() =>
    touchScreen && typeof window !== 'undefined' ? { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight } : null);
  /** Shows where each tap is registered and the geometry behind it (More → Input diagnostics, or ?debug=input). */
  const [debugInput, setDebugInput] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('debug') === 'input'; } catch { return false; }
  });
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
        setViewer({ state: 'connecting', attempt: 0, issue: null });
        setDiagnosticId(null);
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

  // A page restored from the back/forward cache ended its session on pagehide, and its connection
  // is gone: open a new session as a new intent, as Use here does.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) void open(true);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
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

  // Visible, playing desktops count as activity even when the user is only watching.
  // A hidden or disconnected viewer sends false; the server anchors that transition once.
  useEffect(() => {
    if (!session || takenOver) return;
    // A 409 says the session has ended: another tab or device opened the browser, or the browser
    // stopped (it went to sleep or ran out of credit) and its sessions ended with it. Only a browser
    // that is still meant to run was taken over; any other shows its own status.
    const sessionEnded = async () => {
      await queryClient.invalidateQueries({ queryKey: keys.instance(id) });
      if (currentSessionId.current !== session.id) return;
      const latest = queryClient.getQueryData<Instance>(keys.instance(id));
      if (latest && (latest.status === 'running' || latest.desiredState === 'running') && !latest.stopReason) setTakenOver(true);
    };
    const current = sessionHeartbeat<HeartbeatResult>({
      takeInput: () => { const input = hadInput.current; hadInput.current = false; return input; },
      viewing: () => {
        const context = presenceContext.current;
        return viewingPresence(document.visibilityState,
          context.running && context.live && !context.takenOver,
          viewerRef.current?.isDisplaying() ?? false);
      },
      nextSequence: () => ++presenceSequence.current,
      send: (body, signal) => api<HeartbeatResult>('POST', `/sessions/${session.id}/heartbeat`, { body, signal, keepalive: true }),
      result: (r) => {
        setSleepAt(r.sleepAt ? Date.parse(r.sleepAt) : null);
        setSleepReason(r.reason ?? 'idle');
      },
      error: (e) => {
        if (e instanceof ApiError && e.status === 409) void sessionEnded();
        else if (e instanceof ApiError && [401, 402, 403, 404].includes(e.status)) setOpenError(e);
      },
    });
    heartbeat.current = current;
    document.addEventListener('visibilitychange', current.refresh);
    window.addEventListener('pageshow', current.refresh);
    return () => {
      document.removeEventListener('visibilitychange', current.refresh);
      window.removeEventListener('pageshow', current.refresh);
      current.dispose();
      if (heartbeat.current === current) heartbeat.current = null;
    };
  }, [session?.id, takenOver]);

  useEffect(() => { heartbeat.current?.refresh(); }, [viewer.state, status]);

  // Out of credit: say so once, while there is still time to finish up (page 6).
  const toast = useToast();
  useEffect(() => {
    if (sleepReason === 'idle' || !sleepAt) return;
    const minutes = Math.max(1, Math.round((sleepAt - Date.now()) / 60_000));
    toast(t('session.balanceOut', { minutes }), 'error');
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

  // On a touch screen the frame is not fixed to the viewport: it is laid out within the page at
  // the visual viewport's position and size, at all times. WebKit paints a fixed element pinned to
  // the visual viewport while it lays out and hit-tests it against the layout viewport; whenever
  // the two differ (iOS pans and shrinks the visible area for the on-screen keyboard, and iOS 26
  // can leave it offset or short after the keyboard closes, even from the sign-in page earlier in
  // the tab) the picture was drawn lower than where taps were registered, so a tap landed below
  // what it touched. An absolutely positioned frame is painted and hit-tested in one place. The
  // page itself never scrolls (overflow hidden below), so page and layout coordinates agree. The
  // remote screen keeps its size while typing (the viewer stops resizing it), so the picture
  // scales down proportionally into the space above the keyboard instead of being covered.
  useEffect(() => {
    if (!touchScreen) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Pinch zoom also shrinks the visual viewport; the frame then keeps its size.
        if (viewport.scale > 1.01) return;
        const next = {
          top: Math.max(0, Math.round(viewport.pageTop)),
          left: Math.max(0, Math.round(viewport.pageLeft)),
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
        };
        setVisibleArea((prev) => prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.height === next.height ? prev : next);
      });
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, [touchScreen]);

  // The frame is laid out within the page on touch screens: the page itself must never scroll.
  // With the root's overflow hidden, the body's own overflow is not passed to the viewport: the
  // body clips. A modal layer's scroll lock (the toolbar's menus) sets `position: relative` on the
  // body, which then becomes the frame's containing block; holding only absolutely positioned
  // content it was 0 px tall and clipped the whole frame (a black page behind the open menu).
  // A full-height body cannot clip it.
  useEffect(() => {
    if (!touchScreen) return;
    const html = document.documentElement;
    const body = document.body;
    const previous = [html.style.overflow, body.style.overflow, html.style.height, body.style.height];
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    html.style.height = '100%';
    body.style.height = '100%';
    return () => {
      html.style.overflow = previous[0]!;
      body.style.overflow = previous[1]!;
      html.style.height = previous[2]!;
      body.style.height = previous[3]!;
    };
  }, [touchScreen]);

  // iOS can leave the page panned after the keyboard closes: put it back, and again once the
  // keyboard's closing animation is over.
  useEffect(() => {
    if (keyboardOpen) return;
    const restore = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };
    restore();
    const later = setTimeout(restore, KEYBOARD_CLOSE_SETTLE_MS);
    return () => clearTimeout(later);
  }, [keyboardOpen]);

  // A page in the background loses its connection (Safari suspends it, and the viewer gives up
  // after its attempts); coming back reconnects by itself instead of waiting for Retry.
  const viewerState = viewer.state;
  useEffect(() => {
    if (viewerState !== 'failed') return;
    const resume = () => {
      if (document.visibilityState !== 'visible') return;
      setConnectionError(null);
      viewerRef.current?.reconnect();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, [viewerState]);

  const toggleFullscreen = async () => {
    if (maximized) {
      setMaximized(false);
      viewerRef.current?.focus();
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if (!maximizesInPage()) {
      try {
        await frameRef.current?.requestFullscreen();
        // Lets Ctrl+W, T, N and Tab reach the remote browser in fullscreen (page 5).
        const kb = (navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void> } }).keyboard;
        await kb?.lock?.().catch(() => {});
        return;
      } catch {
        // Refused (an embedded page, a browser without it): maximize within the page instead.
      }
    }
    setMaximized(true);
    viewerRef.current?.focus();
  };
  const enlarged = fullscreen || maximized;

  const stayAwake = () => {
    hadInput.current = true;
    heartbeat.current?.refresh();
  };

  const i = instance.data;
  const region = useRegionInfo(i?.regionId ?? '');
  const regionName = region.name;
  regionRtt.current = useRegionLatency(region, i?.status === 'running');
  const idleLeft = sleepAt ? sleepAt - now : Infinity;

  // The session page replaces itself in history: Back from the browsers list must not reopen it.
  const back = () => navigate('/browsers', { replace: true });
  const failed = (e: unknown) => toast(errorMessage(e), 'error');
  const restart = (instanceId: string) => lifecycle.mutate({ id: instanceId, action: 'start' }, { onError: failed });
  const sleep = (instanceId: string) => lifecycle.mutate({ id: instanceId, action: 'stop' }, { onError: failed });

  let overlay: ReactNode = null;
  // A failed refetch keeps the browser loaded before: only a browser that never loaded is an error.
  if (!i && instance.isError) {
    overlay = <Overlay message={errorMessage(instance.error)} action={<Button onClick={back}>{t('session.back')}</Button>} />;
  } else if ((takenOver || viewer.state === 'taken-over') && (!i || i.status === 'running')) {
    // A browser that stopped since says so below instead, with the way to wake it.
    overlay = <Overlay message={t('overlay.elsewhere')} action={<Button variant="primary" onClick={() => void open(true)}>{t('overlay.useHere')}</Button>} />;
  } else if (inputInterrupted) {
    overlay = <Overlay message={t('overlay.inputInterrupted')} body={inputIssue ? <IssueNote issue={inputIssue} drops={unstableDrops} /> : undefined} action={<Button onClick={() => {
      setInputInterrupted(false);
      viewerRef.current?.reconnect();
    }}>{t('overlay.retryNow')}</Button>} />;
  } else if (openError || (connectionError && viewer.state !== 'failed')) {
    overlay = <Overlay message={connectionErrorMessage(openError ?? connectionError)} action={<Button onClick={() => void open()}>{t('common.retry')}</Button>} />;
  } else if (!decodesH264 && i?.status === 'running') {
    // The live view is H.264 (images/browser/neko.yaml); without a decoder the picture stays black.
    overlay = <Overlay message={t('session.h264Unsupported')} action={<Button onClick={back}>{t('session.back')}</Button>} />;
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
                <Button disabled={verify.isPending} onClick={() => verify.mutate(i.id, { onError: failed })}>
                  {t('overlay.checkStatus')}
                </Button>
              }
            />
          ) : (
            <Overlay
              message={t('overlay.error', { reason: i.statusReason ?? '' })}
              body={<p className="font-mono text-xs text-zinc-500">{i.id}</p>}
              action={
                <Button disabled={lifecycle.isPending} onClick={() => restart(i.id)}>
                  {t('overlay.restart')}
                </Button>
              }
            />
          );
        break;
      case 'failed':
        overlay = <Overlay message={t('overlay.failed', { reason: i.statusReason ?? '' })} action={<Button onClick={back}>{t('session.back')}</Button>} />;
        break;
      case 'deleting':
      case 'purged':
        overlay = <Overlay message={t('overlay.deleted')} action={<Button onClick={back}>{t('session.back')}</Button>} />;
        break;
      case 'running':
        if (connect.data?.mode === 'webrtc' && viewer.state === 'failed') {
          overlay = <Overlay
            message={t('overlay.connectionFailed')}
            body={<div className="flex flex-col items-center gap-2 text-center">
              <IssueNote issue={viewer.issue} drops={unstableDrops} />
              {connectionError ? <p className="text-sm text-zinc-400">{connectionErrorMessage(connectionError)}</p> : null}
              {diagnosticId ? <p className="font-mono text-xs text-zinc-400">{t('overlay.connectionReference', { id: diagnosticId })}</p> : null}
            </div>}
            action={<Button onClick={() => {
              setConnectionError(null);
              viewerRef.current?.reconnect();
            }}>{t('overlay.retryNow')}</Button>}
          />;
        } else if (connect.data?.mode === 'webrtc' && viewer.state === 'reconnecting') {
          overlay = (
            <Overlay
              message={t('overlay.reconnecting', { attempt: viewer.attempt })}
              body={viewer.issue ? <IssueNote issue={viewer.issue} drops={unstableDrops} /> : undefined}
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
          overlay = <Overlay message={t('overlay.balanceEnding', { seconds })} />;
        }
        break;
    }
  }

  const live = i?.status === 'running' && connect.data?.mode === 'webrtc' && viewer.state === 'live';
  const agentShown = live && automation !== null && (automation.connected || automation.control.mode !== 'agent');
  const agentKey = agentShown && automation ? agentState(automation) : null;
  const [agentNotice, setAgentNotice] = useState<AgentState | null>(null);
  const lastAgentKey = useRef<AgentState | null>(null);
  // Who drives the browser is shown by the picture's outline and a toolbar button; a change while
  // the user watches is also said once, briefly. A pause found on arrival is not news (it persists until handed back), so only
  // an agent already driving is announced then.
  useEffect(() => {
    if (!agentKey) { lastAgentKey.current = null; return; }
    if (agentKey === lastAgentKey.current) return;
    const first = lastAgentKey.current === null;
    lastAgentKey.current = agentKey;
    if (!first || agentKey === 'agent') setAgentNotice(agentKey);
  }, [agentKey]);
  useEffect(() => {
    if (!agentNotice) return;
    const timer = setTimeout(() => setAgentNotice(null), AGENT_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [agentNotice]);
  const setAgentMode = (mode: AgentControlMode) => setControl.mutate({ id, mode }, { onError: (e) => toast(errorMessage(e), 'error') });

  const toggleRotated = () => {
    const next = !rotated;
    setRotated(next);
    try { localStorage.setItem(ROTATED_KEY, next ? '1' : '0'); } catch { /* Not remembered. */ }
    viewerRef.current?.focus();
  };

  const onTransfer = (update: TransferUpdate) => {
    if (update.state === 'uploading' && update.bytes >= LARGE_TRANSFER_BYTES) toast(t('session.fileSending', { size: formatBytes(update.bytes) }));
    if (update.state !== 'error') return;
    // A text paste carries no files; the viewer refuses one too large to send.
    if (update.files === 0 && update.reason === 'too_large') return toast(t('session.pasteTooLarge'), 'error');
    const key: MessageKey = { too_large: 'session.fileTooLarge', too_many: 'session.fileTooMany', not_on_page: 'session.fileNotOnPage', unsupported: 'session.fileUnsupported', timeout: 'session.fileUnsupported' }[update.reason ?? ''] as MessageKey | undefined ?? 'session.fileFailed';
    toast(t(key), 'error');
  };

  const rotateButton = touchDevice ? (
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
  ) : null;
  const keyboardButton = (
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
  );
  const sizeLabel = t(enlarged ? 'session.restore' : maximizesInPage() ? 'session.maximize' : 'session.fullscreen');
  const sizeButton = (
    <Button size="icon" variant="ghost" className="text-zinc-300 hover:bg-zinc-800" aria-label={sizeLabel} title={sizeLabel} aria-pressed={enlarged} onClick={() => void toggleFullscreen()}>
      {enlarged ? <Minimize /> : <Maximize />}
    </Button>
  );

  const pasteLocal = async () => {
    const text = await navigator.clipboard?.readText().catch(() => '');
    if (text) viewerRef.current?.paste(text);
    viewerRef.current?.focus();
  };
  /**
   * A closing menu gives focus back to its trigger, a toolbar button: the keys typed next went
   * nowhere until the picture was clicked again. The live view takes the keyboard back instead.
   */
  const refocusViewer = (event: Event) => {
    event.preventDefault();
    viewerRef.current?.focus();
  };

  const disabledTool = (label: string, Icon: typeof Upload) => (
    <Button key={label} size="icon" variant="ghost" className="text-zinc-300 hover:bg-zinc-800" disabled aria-label={label} title={`${label} · ${t('session.needsStream')}`}>
      <Icon />
    </Button>
  );

  return (
    <div
      ref={frameRef}
      className={cn('cb-dark flex flex-col overflow-hidden overscroll-none bg-frame text-zinc-100', touchScreen ? 'absolute' : 'fixed inset-0 h-dvh')}
      style={touchScreen && visibleArea ? { top: visibleArea.top, left: visibleArea.left, width: visibleArea.width, height: visibleArea.height } : undefined}
    >
      {maximized ? null : (
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-800 px-2">
        <Button size="icon" variant="ghost" className="text-zinc-300 hover:bg-zinc-800" aria-label={t('session.back')} onClick={back}>
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
            <ConnectionIndicator stats={stats} picture={streaming ? t(`session.picture.${streaming}` as MessageKey, { fps: STREAM.fps[streaming] }) : null} />
          ) : connect.data?.mode === 'simulated' ? (
            <span className="mr-2 hidden items-center gap-1.5 text-xs text-zinc-400 md:inline-flex" title={t('session.simulatedHint')}>
              <span className="size-2 rounded-full bg-starting" aria-hidden /> {t('session.simulated')}
            </span>
          ) : null}
          {agentShown && automation ? <AgentControlMenu status={automation} busy={setControl.isPending} onMode={setAgentMode} onCloseAutoFocus={refocusViewer} /> : null}
          {rotateButton}
          {keyboardButton}
          <div className="hidden items-center gap-0.5 sm:flex">
            {live ? (
              <Button
                size="icon"
                variant="ghost"
                className="text-zinc-300 hover:bg-zinc-800"
                aria-label={t('session.pasteLocal')}
                title={t('session.pasteLocal')}
                onClick={() => void pasteLocal()}
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
              </>
            ) : (
              disabledTool(t('session.upload'), Upload)
            )}
            {disabledTool(t('session.downloads'), Download)}
            {live ? (
              <Menu
                onCloseAutoFocus={refocusViewer}
                trigger={
                  <Button size="icon" variant="ghost" className="text-zinc-300 hover:bg-zinc-800" aria-label={t('session.keys')} title={t('session.keys')}>
                    <Command />
                  </Button>
                }
              >
                {Object.entries(COMBOS).map(([label, names]) => (
                  <MenuItem
                    key={label}
                    onSelect={() => viewerRef.current?.sendCombo(names)}
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
          {live ? (
            // Outside the tools that phones hide, so the More menu can open it there too.
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
          ) : null}
          {sizeButton}
          <Menu
            onCloseAutoFocus={refocusViewer}
            trigger={
              <Button size="icon" variant="ghost" className="text-zinc-300 hover:bg-zinc-800" aria-label={t('session.more')}>
                <MoreHorizontal />
              </Button>
            }
          >
            {live ? (
              // A phone held upright has no room for these tools in the toolbar.
              <>
                <MenuItem className="sm:hidden" onSelect={() => void pasteLocal()}>
                  <ClipboardCopy /> {t('session.pasteLocal')}
                </MenuItem>
                <MenuItem className="sm:hidden" onSelect={() => uploadRef.current?.click()}>
                  <Upload /> {t('session.uploadFiles')}
                </MenuItem>
                <MenuItem className="sm:hidden" onSelect={() => setMuted((m) => !m)}>
                  {muted ? <VolumeX /> : <Volume2 />} {t(muted ? 'session.soundOn' : 'session.soundOff')}
                </MenuItem>
                <MenuLabel className="sm:hidden">{t('session.keys')}</MenuLabel>
                {Object.entries(COMBOS).map(([label, names]) => (
                  <MenuItem key={label} className="sm:hidden" onSelect={() => viewerRef.current?.sendCombo(names)}>
                    <span className="font-mono text-xs">{label}</span>
                  </MenuItem>
                ))}
                <MenuSeparator className="sm:hidden" />
              </>
            ) : null}
            <MenuItem disabled={!i || !['needs_attention'].includes(i.status)} onSelect={() => i && restart(i.id)}>
              <RotateCw /> {t('overlay.restart')}
            </MenuItem>
            <MenuItem disabled={i?.status !== 'running'} onSelect={() => i && sleep(i.id)}>
              <Moon /> {t('browsers.sleepNow')}
            </MenuItem>
            <MenuItem
              disabled={!session || takenOver || connect.data?.mode !== 'webrtc'}
              onSelect={() => {
                setConnectionError(null);
                setInputInterrupted(false);
                viewerRef.current?.reconnect();
              }}
            >
              <RefreshCw /> {t('session.reconnect')}
            </MenuItem>
            <MenuItem onSelect={() => setDebugInput((on) => !on)}>
              <Bug /> {t(debugInput ? 'session.inputDiagnosticsOff' : 'session.inputDiagnostics')}
            </MenuItem>
            <MenuItem onSelect={() => navigate(`/browsers/${id}/settings`)}>
              <Settings /> {t('browsers.settings')}
            </MenuItem>
          </Menu>
        </div>
      </header>
      )}

      <div
        className="relative min-h-0 flex-1"
        onPointerDown={() => (hadInput.current = true)}
        onKeyDown={() => (hadInput.current = true)}
        onWheel={() => (hadInput.current = true)}
      >
        {i?.status === 'running' && connect.data?.mode === 'simulated' ? <SimulatedChrome instance={i} regionName={regionName} /> : null}
        {i?.status === 'running' && connect.data?.mode === 'webrtc' && session && !takenOver && decodesH264 ? (
          <RemoteBrowserView
            key={session.id}
            ref={viewerRef}
            onInputError={(_reason, issue) => {
              setInputIssue(issue);
              setInputInterrupted(true);
            }}
            onTransfer={onTransfer}
            rotated={rotated}
            debug={debugInput}
            className="absolute inset-0 bg-frame"
            maxScreenPixels={TIERS[i.tier ?? 'basic'].maxScreenPixels}
            muted={muted}
            onMutedChange={setMuted}
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
            onState={(state, attempt, issue) => {
              // A live view the user's own network dropped: several within a few minutes say it is unstable.
              if (lastViewerState.current === 'live' && state !== 'live' && (issue === 'network' || issue === 'offline')) {
                const at = Date.now();
                networkDrops.current = [...networkDrops.current.filter((drop) => at - drop < UNSTABLE_WINDOW_MS), at];
                setUnstableDrops(networkDrops.current.length);
              }
              lastViewerState.current = state;
              setViewer({ state, attempt, issue });
            }}
            onDiagnostic={(diagnostic) => {
              if (currentSessionId.current !== session.id) return;
              setDiagnosticId(diagnostic.attemptId);
              if (diagnostics.current?.sessionId === session.id) diagnostics.current.reporter.report(diagnostic);
              else if (pendingDiagnostics.current.length < 32) pendingDiagnostics.current.push({ sessionId: session.id, diagnostic });
            }}
            onStats={(reading) => {
              setStats(reading);
              const rtt = reading.rttMs;
              const own = regionRtt.current;
              const far = rtt !== null && own !== null && detour(rtt, own);
              slowReadings.current = rtt !== null && (rtt > SLOW_RTT_MS || far) ? slowReadings.current + 1 : 0;
              setSlowRtt(slowReadings.current >= SLOW_READINGS && rtt !== null ? { rtt, region: far ? own : null } : null);
            }}
            onQualityReport={(report) => {
              if (quality.current?.sessionId === session.id) quality.current.reporter.report(report);
            }}
            onVideo={setStreaming}
            onInput={() => (hadInput.current = true)}
            onKeyboardChange={setKeyboardOpen}
            onAutomation={setAutomation}
          />
        ) : null}
        {i?.status === 'running' && connect.isError ? <Overlay message={connectionErrorMessage(connect.error)} action={<Button onClick={() => void connect.refetch()}>{t('common.retry')}</Button>} /> : null}
        {overlay}
        {maximized ? (
          // The way out of the maximized view, with the keyboard still a tap away (it needs the toolbar's gesture, not the picture's).
          <div role="toolbar" aria-label={t('session.maximizedTools')} className="absolute right-3 bottom-3 z-30 flex items-center gap-0.5 border border-zinc-700 bg-zinc-950/85 p-1 backdrop-blur">
            {agentShown && automation ? <AgentControlMenu status={automation} busy={setControl.isPending} onMode={setAgentMode} onCloseAutoFocus={refocusViewer} /> : null}
            {keyboardButton}
            {rotateButton}
            {sizeButton}
          </div>
        ) : null}
        {agentKey ? (
          // Who has control, said by the picture's edge, which covers nothing of the page.
          <div aria-hidden data-testid="agent-frame" data-control={AGENT_SIDE[agentKey]} className={cn('pointer-events-none absolute inset-0 z-10 transition-shadow duration-300', AGENT_FRAME[agentKey])} />
        ) : null}
        {agentShown && agentNotice ? <AgentNotice state={agentNotice} raised={maximized} onDismiss={() => setAgentNotice(null)} /> : null}
        {live && slowRtt !== null && !slowDismissed && !(agentShown && agentNotice) ? (
          <SlowConnectionNotice rtt={slowRtt.rtt} region={slowRtt.region} raised={maximized} onDismiss={() => setSlowDismissed(true)} />
        ) : null}
        {session && !takenOver && i?.status === 'running' && sleepReason === 'idle' && idleLeft < IDLE_WARNING_MS ? (
          <div role="status" className="absolute inset-x-4 bottom-4 z-20 flex flex-wrap items-center justify-center gap-3 border border-amber-500/50 bg-zinc-950 p-4 text-sm text-zinc-100">
            <span>{t('overlay.idle', { seconds: Math.max(0, Math.ceil(idleLeft / 1000)) })}</span>
            <Button variant="primary" onClick={stayAwake}>{t('overlay.stayAwake')}</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type AgentState = 'agent' | 'idle' | 'user' | 'privacy' | 'disconnected';

/** What the user is told about a coding agent (docs/agent-access.md), from the VM's control report. */
function agentState(status: AutomationStatus): AgentState {
  const { mode, controller } = status.control;
  if (!status.connected) return 'disconnected';
  if (mode === 'privacy' || mode === 'user') return mode;
  return controller === 'agent' ? 'agent' : 'idle';
}

/** Whose the browser is: the agent's while it may act (orange), the user's once they took over (blue). */
const AGENT_SIDE: Record<AgentState, 'agent' | 'user'> = { agent: 'agent', idle: 'agent', user: 'user', privacy: 'user', disconnected: 'user' };

const AGENT_DOT: Record<AgentState, string> = {
  agent: 'bg-orange-500 animate-pulse',
  idle: 'bg-orange-500/60',
  user: 'bg-blue-500',
  privacy: 'bg-blue-500',
  disconnected: 'bg-blue-500',
};

/** The outline around the picture: strongest while the agent is acting, quieter while it only may. */
const AGENT_FRAME: Record<AgentState, string> = {
  agent: 'inset-ring-[3px] inset-ring-orange-500 inset-shadow-[0_0_28px] inset-shadow-orange-500/40',
  idle: 'inset-ring-2 inset-ring-orange-500/50',
  user: 'inset-ring-[3px] inset-ring-blue-500 inset-shadow-[0_0_16px] inset-shadow-blue-500/25',
  privacy: 'inset-ring-[3px] inset-ring-blue-500 inset-shadow-[0_0_16px] inset-shadow-blue-500/25',
  disconnected: 'inset-ring-[3px] inset-ring-blue-500 inset-shadow-[0_0_16px] inset-shadow-blue-500/25',
};

/**
 * Who drives the browser while a coding agent is connected or paused, as a toolbar button: a
 * banner over the picture covered the page the user had just taken over and could not be closed.
 * Any click or key of the user's takes control from the agent (the VM does that, not this menu);
 * the menu is where control is handed back, the agent paused, or a privacy pause (no screenshots
 * either) turned on and off.
 */
function AgentControlMenu({ status, busy, onMode, onCloseAutoFocus }: {
  status: AutomationStatus;
  busy: boolean;
  onMode: (mode: AgentControlMode) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { t } = useI18n();
  const state = agentState(status);
  const { mode } = status.control;
  const message = t(`agents.banner.${state}`);
  return (
    <Menu
      onCloseAutoFocus={onCloseAutoFocus}
      trigger={
        <Button size="icon" variant="ghost" className="relative text-zinc-300 hover:bg-zinc-800" aria-label={`${t('agents.chip')}: ${message}`} title={message} data-testid="agent-control">
          <Bot />
          <span aria-hidden className={cn('absolute top-1.5 right-1.5 size-2 rounded-full ring-2 ring-zinc-950', AGENT_DOT[state])} />
        </Button>
      }
    >
      <p role="status" className="max-w-72 px-2.5 py-2 text-sm leading-snug">{message}</p>
      <MenuSeparator />
      {mode !== 'agent' ? <MenuItem disabled={busy} onSelect={() => onMode('agent')}><Play /> {t('agents.handBack')}</MenuItem> : null}
      {mode === 'agent' && status.connected ? <MenuItem disabled={busy} onSelect={() => onMode('user')}><Hand /> {t('agents.pause')}</MenuItem> : null}
      {mode === 'privacy'
        ? <MenuItem disabled={busy} onSelect={() => onMode('user')}><Eye /> {t('agents.privacyOff')}</MenuItem>
        : status.connected ? <MenuItem disabled={busy} onSelect={() => onMode('privacy')}><EyeOff /> {t('agents.privacy')}</MenuItem> : null}
    </Menu>
  );
}

/**
 * A change of who drives the browser, said once over the picture: small, closable, and gone after
 * a few seconds. It sits at the bottom, away from Chrome's tabs and address bar, which the user
 * often reaches for right after taking over; above the maximized view's controls when they show.
 */
function AgentNotice({ state, raised, onDismiss }: { state: AgentState; raised: boolean; onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div role="status" data-testid="agent-notice" className={cn('absolute left-1/2 z-20 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 border border-l-2 border-zinc-700 bg-zinc-950/90 py-1 pr-1 pl-3 text-xs text-zinc-100 shadow-pop backdrop-blur', raised ? 'bottom-16' : 'bottom-3', AGENT_SIDE[state] === 'agent' ? 'border-l-orange-500' : 'border-l-blue-500')}>
      <Bot className={cn('size-3.5 shrink-0', AGENT_SIDE[state] === 'agent' ? 'text-orange-400' : 'text-blue-400')} aria-hidden />
      <span className="min-w-0">{t(`agents.banner.${state}`)}</span>
      <button type="button" className="grid size-6 shrink-0 place-items-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label={t('agents.notice.dismiss')} onClick={onDismiss}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * Why the live view is reconnecting or failed, as the viewer could tell (packages/viewer
 * ConnectionIssue), and when the user's network keeps dropping it, that it is unstable.
 */
function IssueNote({ issue, drops }: { issue: ConnectionIssue | null; drops: number }) {
  const { t } = useI18n();
  const unstable = drops >= UNSTABLE_DROPS && (issue === 'network' || issue === 'offline');
  if (!issue) return null;
  return (
    <div className="flex max-w-sm flex-col gap-1.5 text-center text-sm leading-relaxed text-zinc-400" data-testid="connection-issue" data-issue={issue}>
      <p>{t(`overlay.issue.${issue}` as MessageKey)}</p>
      {issue === 'network' && !unstable ? <p>{t('overlay.issue.networkHint')}</p> : null}
      {unstable ? <p className="text-amber-300">{t('overlay.issue.unstable', { count: drops })}</p> : null}
    </div>
  );
}

/**
 * A round trip slow enough that taps visibly lag, said once and closable, beside the picture's
 * edge. With `region`, the user's own round trip to the browser's region: the picture takes a
 * longer way than the page, and the notice says why that usually is.
 */
function SlowConnectionNotice({ rtt, region, raised, onDismiss }: { rtt: number; region: number | null; raised: boolean; onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div role="status" data-testid="slow-connection" className={cn('absolute left-1/2 z-20 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 border border-l-2 border-zinc-700 border-l-amber-500 bg-zinc-950/90 py-1 pr-1 pl-3 text-xs text-zinc-100 shadow-pop backdrop-blur', raised ? 'bottom-16' : 'bottom-3')}>
      <Gauge className="size-3.5 shrink-0 text-amber-400" aria-hidden />
      <span className="min-w-0">{region !== null ? t('session.slowConnectionDetour', { rtt, region }) : t('session.slowConnection', { rtt })}</span>
      <button type="button" className="grid size-6 shrink-0 place-items-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label={t('session.slowConnectionDismiss')} onClick={onDismiss}>
        <X className="size-3.5" />
      </button>
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
    <>
      {/* Phones and narrow tablets: the quality at a glance, and the round trip when it is poor. */}
      <span className="mr-1 inline-flex items-center gap-1 font-mono text-[11px] text-zinc-400 md:hidden" title={details}>
        <span className={cn('size-2 rounded-full', color)} aria-hidden />
        {level === 'poor' && stats.rttMs !== null ? `${stats.rttMs} ms` : null}
      </span>
      <span className="mr-2 hidden items-center gap-1.5 font-mono text-xs text-zinc-300 md:inline-flex" title={details} data-testid="connection-indicator">
        <span className={cn('size-2 rounded-full', color)} aria-hidden />
        {stats.rttMs !== null ? `${stats.rttMs} ms` : '—'}
        {stats.fps !== null ? <span className="text-zinc-500">· {stats.fps} fps</span> : null}
      </span>
    </>
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
