import { expect, it, vi } from 'vitest';
import { observeFirstFrame } from '../src/first-frame.js';

it('records a video frame only when its callback belongs to the current stream', () => {
  const stream = {} as MediaStream;
  let frame!: () => void;
  const video = {
    srcObject: stream,
    requestVideoFrameCallback: vi.fn((callback: () => void) => { frame = callback; return 7; }),
    cancelVideoFrameCallback: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const received = vi.fn();
  const stop = observeFirstFrame(video as unknown as HTMLVideoElement, stream, received);
  expect(received).not.toHaveBeenCalled();
  video.srcObject = {} as MediaStream;
  frame();
  expect(received).not.toHaveBeenCalled();
  stop();
  video.srcObject = stream;
  frame();
  expect(received).not.toHaveBeenCalled();
  expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(7);
});

it('confirms one decoded frame and removes the loadeddata fallback on older browsers', () => {
  const stream = {} as MediaStream;
  let loaded!: () => void;
  const video = {
    srcObject: stream,
    readyState: 1,
    videoWidth: 0,
    videoHeight: 0,
    addEventListener: vi.fn((_event: string, callback: () => void) => { loaded = callback; }),
    removeEventListener: vi.fn(),
  };
  const received = vi.fn();
  const stop = observeFirstFrame(video as unknown as HTMLVideoElement, stream, received);
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
  expect(video.removeEventListener).toHaveBeenCalledWith('loadeddata', loaded);
  stop();
});
