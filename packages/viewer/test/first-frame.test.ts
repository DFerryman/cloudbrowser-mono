import { expect, it, vi } from 'vitest';
import { observeFirstFrame } from '../src/first-frame.js';

function element(stream: MediaStream, presents: boolean) {
  const listeners = new Map<string, () => void>();
  let frame: (() => void) | undefined;
  const video = {
    srcObject: stream,
    readyState: 1,
    videoWidth: 0,
    videoHeight: 0,
    addEventListener: vi.fn((event: string, callback: () => void) => { listeners.set(event, callback); }),
    removeEventListener: vi.fn((event: string) => { listeners.delete(event); }),
    ...(presents ? {
      requestVideoFrameCallback: vi.fn((callback: () => void) => { frame = callback; return 7; }),
      cancelVideoFrameCallback: vi.fn(),
    } : {}),
  };
  return { video, loaded: () => listeners.get('loadeddata')?.(), resized: () => listeners.get('resize')?.(), present: () => frame?.(), listeners };
}

function page(visibilityState: DocumentVisibilityState) {
  const listeners = new Set<() => void>();
  return {
    visibilityState,
    addEventListener: vi.fn((_event: string, callback: () => void) => { listeners.add(callback); }),
    removeEventListener: vi.fn((_event: string, callback: () => void) => { listeners.delete(callback); }),
    change(state: DocumentVisibilityState) { this.visibilityState = state; for (const l of [...listeners]) l(); },
    listeners,
  };
}

it('records a video frame only when its callback belongs to the current stream', () => {
  const stream = {} as MediaStream;
  const { video, present } = element(stream, true);
  const received = vi.fn();
  const stop = observeFirstFrame(video as unknown as HTMLVideoElement, stream, received, page('visible') as unknown as Document);
  expect(received).not.toHaveBeenCalled();
  video.srcObject = {} as MediaStream;
  present();
  expect(received).not.toHaveBeenCalled();
  stop();
  video.srcObject = stream;
  present();
  expect(received).not.toHaveBeenCalled();
  expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(7);
});

it('waits for a presented frame on a shown page, even with data decoded', () => {
  const stream = {} as MediaStream;
  const { video, loaded, present } = element(stream, true);
  const received = vi.fn();
  observeFirstFrame(video as unknown as HTMLVideoElement, stream, received, page('visible') as unknown as Document);
  Object.assign(video, { readyState: 4, videoWidth: 1280, videoHeight: 720 });
  loaded();
  expect(received).not.toHaveBeenCalled();
  present();
  expect(received).toHaveBeenCalledTimes(1);
});

it('takes a decoded frame on a hidden page, which presents none', () => {
  const stream = {} as MediaStream;
  const { video, loaded, present, listeners } = element(stream, true);
  const shown = page('hidden');
  const received = vi.fn();
  observeFirstFrame(video as unknown as HTMLVideoElement, stream, received, shown as unknown as Document);
  loaded();
  expect(received).not.toHaveBeenCalled(); // Nothing decoded yet.
  Object.assign(video, { readyState: 4, videoWidth: 1280, videoHeight: 720 });
  loaded();
  present();
  expect(received).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
  expect(shown.listeners.size).toBe(0);
  expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(7);
});

it('takes the decoded frame when the page is hidden after the video got data', () => {
  const stream = {} as MediaStream;
  const { video, loaded } = element(stream, true);
  const shown = page('visible');
  const received = vi.fn();
  observeFirstFrame(video as unknown as HTMLVideoElement, stream, received, shown as unknown as Document);
  Object.assign(video, { readyState: 4, videoWidth: 1280, videoHeight: 720 });
  loaded();
  expect(received).not.toHaveBeenCalled();
  shown.change('hidden');
  expect(received).toHaveBeenCalledTimes(1);
});

it('takes the picture size that arrives after audio on a hidden page', () => {
  const stream = {} as MediaStream;
  const { video, loaded, resized } = element(stream, true);
  const received = vi.fn();
  observeFirstFrame(video as unknown as HTMLVideoElement, stream, received, page('hidden') as unknown as Document);
  video.readyState = 4;
  loaded();
  expect(received).not.toHaveBeenCalled(); // Audio first: no picture size yet.
  Object.assign(video, { videoWidth: 1280, videoHeight: 720 });
  resized();
  expect(received).toHaveBeenCalledTimes(1);
});

it('confirms one decoded frame and removes the loadeddata fallback on older browsers', () => {
  const stream = {} as MediaStream;
  const { video, loaded, listeners } = element(stream, false);
  const received = vi.fn();
  const stop = observeFirstFrame(video as unknown as HTMLVideoElement, stream, received, page('visible') as unknown as Document);
  loaded();
  expect(received).not.toHaveBeenCalled();
  video.readyState = 2;
  loaded();
  expect(received).not.toHaveBeenCalled(); // Audio alone is not a decoded video frame.
  video.videoWidth = 1280;
  video.videoHeight = 720;
  loaded();
  loaded();
  expect(received).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
  stop();
});
