import { describe, expect, it, vi } from 'vitest';
import { isDisplaying, playbackFailure, readPlayback } from '../src/playback.js';

const video = () => ({ paused: false, readyState: 4, videoWidth: 1920, videoHeight: 1080 });

describe('playback snapshots', () => {
  it('exports only bounded playback state', () => {
    expect(readPlayback(video(), { visibility: 'visible', playState: 'resolved', frameCallback: true })).toEqual({
      paused: false, readyState: 4, width: 1920, height: 1080,
      visibility: 'visible', playState: 'resolved', frameCallback: true,
    });
    expect(readPlayback({ paused: true, readyState: 0, videoWidth: 0, videoHeight: 0 })).toEqual({
      paused: true, readyState: 0, width: 0, height: 0,
      visibility: 'unknown', playState: 'unknown', frameCallback: false,
    });
  });

  it.each([0, 1, 2, 3, 4])('accepts video readiness %s and inclusive dimension boundaries', (readyState) => {
    expect(readPlayback({ ...video(), readyState, videoWidth: 32_768, videoHeight: 0 })).toMatchObject({
      readyState, width: 32_768, height: 0,
    });
  });

  it.each(['unknown', 'resolved', 'not_allowed', 'unsupported', 'aborted', 'failed'])('retains the fixed play state %s', (playState) => {
    expect(readPlayback(video(), { visibility: 'hidden', playState, frameCallback: false })).toMatchObject({
      visibility: 'hidden', playState, frameCallback: false,
    });
  });

  it.each([
    { paused: 0 }, { paused: 'false' }, { readyState: -1 }, { readyState: 5 }, { readyState: 1.5 },
    { readyState: '4' }, { readyState: Number.NaN }, { videoWidth: -1 }, { videoWidth: 32_769 },
    { videoWidth: 1.5 }, { videoWidth: Infinity }, { videoHeight: '1080' }, { videoHeight: Number.MAX_SAFE_INTEGER },
  ])('rejects malformed mandatory state %j without coercion', (invalid) => {
    expect(readPlayback({ ...video(), ...invalid })).toBeUndefined();
  });

  it.each([undefined, null, false, 'video', 1])('omits absent or invalid video %s', (source) => {
    expect(readPlayback(source)).toBeUndefined();
  });

  it('never inspects or exports URLs, error messages or unrelated media fields', () => {
    const forbidden = vi.fn(() => { throw new Error('secret-token'); });
    const source = Object.defineProperties(video(), {
      src: { get: forbidden }, srcObject: { get: forbidden }, error: { get: forbidden },
      token: { get: forbidden }, sdp: { get: forbidden },
    });
    const result = readPlayback(source, { visibility: 'https://private/?token=secret', playState: 'private SDP' });
    expect(result).toMatchObject({ visibility: 'unknown', playState: 'unknown' });
    expect(forbidden).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/secret|private|https|sdp/i);
  });

  it('does not coerce optional state or accept a truthy frame callback flag', () => {
    const coercion = vi.fn(() => { throw new Error('do not stringify'); });
    const unsafe = { toString: coercion, valueOf: coercion };
    expect(readPlayback(video(), { visibility: unsafe, playState: unsafe })).toMatchObject({ visibility: 'unknown', playState: 'unknown' });
    expect(readPlayback(video(), { frameCallback: 'yes' })).toBeUndefined();
    expect(coercion).not.toHaveBeenCalled();
  });

  it('omits a snapshot if a mandatory or supplied option getter throws', () => {
    const source = Object.defineProperty(video(), 'videoWidth', { get: () => { throw new Error('private URL'); } });
    expect(readPlayback(source)).toBeUndefined();
    const options = Object.defineProperty({}, 'playState', { get: () => { throw new Error('private message'); } });
    expect(readPlayback(video(), options)).toBeUndefined();
  });
});

describe('play rejection classification', () => {
  it.each([
    ['NotAllowedError', 'not_allowed'], ['NotSupportedError', 'unsupported'], ['AbortError', 'aborted'],
    ['TypeError', 'failed'], ['unknown-secret', 'failed'],
  ])('maps %s using only the fixed exception name', (name, expected) => {
    const message = vi.fn(() => { throw new Error('secret URL and token'); });
    const error = Object.defineProperties({ name }, { message: { get: message }, stack: { get: message } });
    expect(playbackFailure(error)).toBe(expected);
    expect(message).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 'NotAllowedError', 1, true, { name: { toString: () => 'NotAllowedError' } }])('safely rejects nonstandard errors', (error) => {
    expect(playbackFailure(error)).toBe('failed');
  });

  it('returns failed if the name getter throws', () => {
    expect(playbackFailure(Object.defineProperty({}, 'name', { get: () => { throw new Error('secret'); } }))).toBe('failed');
  });
});

describe('current video display', () => {
  const stream = (tracks: unknown) => ({ getVideoTracks: () => tracks });
  const displaying = () => ({ ...video(), ended: false, srcObject: stream([{ kind: 'video', readyState: 'live' }]) });

  it('requires a current live video track on the attached, playing video element', () => {
    expect(isDisplaying(displaying())).toBe(true);
    expect(isDisplaying({ ...displaying(), srcObject: stream([{ kind: 'audio', readyState: 'live' }, { kind: 'video', readyState: 'ended' }, { kind: 'video', readyState: 'live' }]) })).toBe(true);
  });

  it.each([2, 3, 4])('accepts ready state %s with positive bounded dimensions', (readyState) => {
    expect(isDisplaying({ ...displaying(), readyState, videoWidth: 32_768, videoHeight: 1 })).toBe(true);
  });

  it.each([
    { paused: true }, { paused: 0 }, { ended: true }, { ended: undefined }, { ended: 0 },
    { readyState: 0 }, { readyState: 1 }, { readyState: 5 }, { readyState: 2.5 },
    { videoWidth: 0 }, { videoHeight: 0 }, { videoWidth: 32_769 }, { videoHeight: Number.NaN },
    { srcObject: null }, { srcObject: undefined }, { srcObject: {} }, { srcObject: { getVideoTracks: true } },
  ])('rejects incomplete, paused, ended or malformed display state %j', (invalid) => {
    expect(isDisplaying({ ...displaying(), ...invalid })).toBe(false);
  });

  it.each([
    [], [{ kind: 'audio', readyState: 'live' }], [{ kind: 'video', readyState: 'ended' }],
    [{ kind: 'video', readyState: true }], [null, undefined, false],
    null, undefined, { 0: { kind: 'video', readyState: 'live' }, length: 1 },
  ].map((tracks) => ({ tracks })))('rejects missing or non-live video tracks $tracks', ({ tracks }) => {
    expect(isDisplaying({ ...displaying(), srcObject: stream(tracks) })).toBe(false);
  });

  it('calls getVideoTracks with the attached stream as receiver', () => {
    const source = {
      getVideoTracks(this: unknown) {
        expect(this).toBe(source);
        return [{ kind: 'video', readyState: 'live' }];
      },
    };
    expect(isDisplaying({ ...displaying(), srcObject: source })).toBe(true);
  });

  it('returns false for throwing element, stream or track getters', () => {
    const throws = () => { throw new Error('private URL'); };
    expect(isDisplaying(Object.defineProperty(displaying(), 'ended', { get: throws }))).toBe(false);
    expect(isDisplaying(Object.defineProperty(displaying(), 'srcObject', { get: throws }))).toBe(false);
    expect(isDisplaying({ ...displaying(), srcObject: Object.defineProperty({}, 'getVideoTracks', { get: throws }) })).toBe(false);
    expect(isDisplaying({ ...displaying(), srcObject: { getVideoTracks: throws } })).toBe(false);
    expect(isDisplaying({ ...displaying(), srcObject: stream([Object.defineProperty({ kind: 'video' }, 'readyState', { get: throws })]) })).toBe(false);
  });

  it('does not read URLs, labels, IDs or content to decide whether a picture is present', () => {
    const forbidden = vi.fn(() => { throw new Error('private content'); });
    const track = Object.defineProperties({ kind: 'video', readyState: 'live' }, { label: { get: forbidden }, id: { get: forbidden } });
    const source = Object.defineProperties({ ...displaying(), srcObject: stream([track]) }, { src: { get: forbidden }, error: { get: forbidden } });
    expect(isDisplaying(source)).toBe(true);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each([undefined, null, false, 1, 'video'])('returns false for absent/non-element %s', (source) => {
    expect(isDisplaying(source)).toBe(false);
  });
});
