import test from 'node:test';
import assert from 'node:assert/strict';
import {RADIO_PLAYLIST} from './radio-playlist.js';
import {RadioPlayer,loadYouTubeApi,clampVolume} from './radio.js';

function fakeYT() {
  const log = [];
  class Player {
    constructor(el, opts) { this.opts = opts; this.log = log; Player.last = this; log.push(['new', opts.videoId]); queueMicrotask(() => opts.events.onReady()); }
    playVideo() { log.push(['play']); } pauseVideo() { log.push(['pause']); } stopVideo() { log.push(['stop']); }
    loadVideoById(id) { log.push(['load', id]); } setVolume(v) { log.push(['vol', v]); }
  }
  return {YT: {Player}, log, Player};
}
const make = (extra = {}) => { const f = fakeYT(); const r = new RadioPlayer({loadApi: async () => f.YT, mount: () => ({}), enabled: true, ...extra}); return {...f, r}; };

test('playlist: Peacebloom first, unique valid ids, 10-20 tracks', () => {
  assert.match(RADIO_PLAYLIST[0].title, /^Peacebloom/);
  assert.ok(RADIO_PLAYLIST.length >= 10 && RADIO_PLAYLIST.length <= 20);
  assert.equal(new Set(RADIO_PLAYLIST.map(t => t.id)).size, RADIO_PLAYLIST.length);
  for (const t of RADIO_PLAYLIST) { assert.match(t.id, /^[\w-]{11}$/); assert.ok(t.title); }
});

test('nothing loads until play (lazy), and play creates a hidden 1px player on track 0', async () => {
  let loads = 0;
  const f = fakeYT();
  const r = new RadioPlayer({loadApi: async () => { loads++; return f.YT; }, mount: () => ({}), enabled: true});
  assert.equal(loads, 0);
  assert.equal(r.status, 'idle');
  assert.equal(await r.play(), true);
  assert.equal(loads, 1);
  assert.deepEqual([f.Player.last.opts.width, f.Player.last.opts.height, f.Player.last.opts.videoId], [1, 1, RADIO_PLAYLIST[0].id]);
  assert.equal(f.Player.last.opts.playerVars.controls, 0);
  assert.deepEqual(f.log.at(-1), ['play']);
  assert.equal(r.status, 'ready');
});

test('disabled radio never loads the API', async () => {
  let loads = 0;
  const r = new RadioPlayer({loadApi: async () => { loads++; }, mount: () => ({}), enabled: false});
  assert.equal(r.status, 'off');
  assert.equal(await r.play(), false);
  assert.equal(loads, 0);
});

test('next/prev wrap and load the video; ended advances', async () => {
  const {r, log, Player} = make();
  await r.play();
  await r.prev();
  assert.equal(r.index, RADIO_PLAYLIST.length - 1);
  assert.deepEqual(log.at(-1), ['load', RADIO_PLAYLIST.at(-1).id]);
  await r.next();
  assert.equal(r.index, 0);
  Player.last.opts.events.onStateChange({data: 1});
  assert.equal(r.playing, true);
  Player.last.opts.events.onStateChange({data: 0});
  assert.equal(r.index, 1);
  assert.equal(r.playing, false);
});

test('pause stops auto-advance; toggle resumes', async () => {
  const {r, Player} = make();
  await r.play();
  Player.last.opts.events.onStateChange({data: 1});
  await r.toggle();
  Player.last.opts.events.onStateChange({data: 2});
  assert.equal(r.playing, false);
  Player.last.opts.events.onStateChange({data: 0});
  assert.equal(r.index, 0);
  await r.toggle();
  assert.equal(r.wantPlay, true);
});

test('volume clamps, applies to the player, and survives player creation', async () => {
  assert.equal(clampVolume(150), 100);
  assert.equal(clampVolume(-5), 0);
  assert.equal(clampVolume('abc'), 0);
  const {r, log} = make({volume: 30});
  r.setVolume(999);
  assert.equal(r.volume, 100);
  await r.play();
  assert.deepEqual(log.filter(e => e[0] === 'vol').at(-1), ['vol', 100]);
  r.setVolume(20);
  assert.deepEqual(log.at(-1), ['vol', 20]);
});

test('embed errors skip tracks; all failing marks unavailable without throwing', async () => {
  const {r, Player} = make();
  await r.play();
  Player.last.opts.events.onError({data: 101});
  assert.equal(r.index, 1);
  assert.equal(r.status, 'ready');
  for (let i = 0; i < RADIO_PLAYLIST.length; i++) Player.last.opts.events.onError({data: 150});
  assert.equal(r.status, 'unavailable');
  assert.equal(await r.play(), false);
});

test('API load failure degrades to unavailable, no throw, no retry storm', async () => {
  let loads = 0;
  const changes = [];
  const r = new RadioPlayer({loadApi: async () => { loads++; throw new Error('offline'); }, mount: () => ({}), enabled: true, onChange: s => changes.push(s.status)});
  assert.equal(await r.play(), false);
  assert.equal(r.status, 'unavailable');
  assert.equal(await r.play(), false);
  assert.equal(loads, 1);
  assert.ok(changes.includes('unavailable'));
  assert.doesNotThrow(() => { r.next(); r.prev(); r.setVolume(10); r.pause(); });
});

test('a throwing onChange listener or player never escapes', async () => {
  const {r, Player} = make({onChange: () => { throw new Error('ui'); }});
  await r.play();
  Player.last.playVideo = () => { throw new Error('player gone'); };
  assert.doesNotThrow(() => r.next());
  await r.play();
  assert.equal(r.status, 'unavailable');
});

test('disabling stops playback; concurrent plays share one player', async () => {
  const {r, log} = make();
  await Promise.all([r.play(), r.play()]);
  assert.equal(log.filter(e => e[0] === 'new').length, 1);
  r.setEnabled(false);
  assert.deepEqual(log.at(-1), ['stop']);
  assert.equal(r.status, 'off');
});

test('loadYouTubeApi injects one script, resolves on ready callback, rejects on error/timeout', async () => {
  const mk = () => { const head = []; const doc = {createElement: () => ({}), head: {append: s => head.push(s)}}; return {doc, head, win: {}}; };
  let e = mk();
  const ok = loadYouTubeApi(e);
  assert.equal(e.head[0].src, 'https://www.youtube.com/iframe_api');
  e.win.YT = {Player() {}};
  e.win.onYouTubeIframeAPIReady();
  assert.equal(await ok, e.win.YT);
  e = mk();
  const bad = loadYouTubeApi(e);
  e.head[0].onerror();
  await assert.rejects(bad, /failed to load/);
  e = mk();
  await assert.rejects(loadYouTubeApi({...e, timeoutMs: 5}), /timed out/);
  e = mk();
  e.win.YT = {Player() {}};
  assert.equal(await loadYouTubeApi(e), e.win.YT);
  assert.equal(e.head.length, 0);
});
