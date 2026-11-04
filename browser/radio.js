import {RADIO_PLAYLIST} from './radio-playlist.js';

const API_URL = 'https://www.youtube.com/iframe_api';
const STATE = {ENDED: 0, PLAYING: 1, PAUSED: 2};
export const clampVolume = v => Math.max(0, Math.min(100, Math.round(Number(v)) || 0));

/** Injects the YouTube IFrame API script once. Rejects (never throws) when offline, blocked, or slow. */
export function loadYouTubeApi({win = globalThis, doc = globalThis.document, timeoutMs = 10000} = {}) {
  if (win.YT?.Player) return Promise.resolve(win.YT);
  return new Promise((resolve, reject) => {
    let timer;
    const fail = why => { clearTimeout(timer); reject(new Error(why)); };
    try {
      const previous = win.onYouTubeIframeAPIReady;
      win.onYouTubeIframeAPIReady = () => {
        clearTimeout(timer);
        try { previous?.(); } catch { /* another listener's failure is not ours */ }
        win.YT?.Player ? resolve(win.YT) : reject(new Error('YouTube API loaded without a player'));
      };
      const script = doc.createElement('script');
      script.src = API_URL;
      script.async = true;
      script.onerror = () => fail('YouTube API failed to load');
      timer = setTimeout(() => fail('YouTube API timed out'), timeoutMs);
      doc.head.append(script);
    } catch (error) { fail(error.message); }
  });
}

/**
 * Radio over a hidden YouTube player. The API is loaded lazily on first play, never at construction.
 * status: 'off' | 'idle' | 'loading' | 'ready' | 'unavailable'. Every failure ends in 'unavailable'; nothing throws to the page.
 */
export class RadioPlayer {
  constructor({loadApi = loadYouTubeApi, mount, playlist = RADIO_PLAYLIST, volume = 50, enabled = false, onChange = () => {}} = {}) {
    Object.assign(this, {loadApi, mount, playlist, onChange, enabled, volume: clampVolume(volume), index: 0, playing: false, status: enabled ? 'idle' : 'off', player: null, loading: null, errorRun: 0, wantPlay: false});
  }
  get track() { return this.playlist[this.index]; }
  get available() { return this.status !== 'unavailable'; }
  emit() { try { this.onChange(this); } catch { /* UI listener failure must not stop playback */ } }
  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) { this.stop(); this.status = this.status === 'unavailable' ? 'unavailable' : 'off'; }
    else if (this.status === 'off') this.status = 'idle';
    this.emit();
  }
  setVolume(value) {
    this.volume = clampVolume(value);
    try { this.player?.setVolume?.(this.volume); } catch { /* player not ready */ }
    this.emit();
  }
  // Must be called from a user gesture the first time: browsers block audio before one.
  async play() {
    if (!this.enabled || !this.available) return false;
    this.wantPlay = true;
    if (!this.player && !await this.ensurePlayer()) return false;
    this.send(p => p.playVideo());
    return true;
  }
  pause() { this.wantPlay = false; this.send(p => p.pauseVideo()); }
  stop() { this.wantPlay = false; this.send(p => p.stopVideo()); this.playing = false; }
  toggle() { return this.playing || this.wantPlay ? (this.pause(), Promise.resolve(false)) : this.play(); }
  next() { return this.go(1); }
  prev() { return this.go(-1); }
  go(step) {
    const n = this.playlist.length;
    this.index = (this.index + step + n) % n;
    this.emit();
    if (!this.player) return this.wantPlay ? this.play() : Promise.resolve(false);
    this.wantPlay = true;
    this.send(p => p.loadVideoById(this.track.id));
    return Promise.resolve(true);
  }
  send(fn) {
    try { if (this.player) fn(this.player); } catch (error) { this.fail(error); }
  }
  fail() {
    this.status = 'unavailable';
    this.playing = false;
    this.wantPlay = false;
    this.emit();
  }
  ensurePlayer() {
    if (this.loading) return this.loading;
    this.status = 'loading';
    this.emit();
    this.loading = (async () => {
      try {
        const YT = await this.loadApi();
        await new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error('YouTube player never became ready')), this.readyTimeoutMs ?? 15000).unref?.();
          this.player =  new YT.Player(this.mount(), {
            width: 1, height: 1, videoId: this.track.id,
            playerVars: {controls: 0, disablekb: 1, fs: 0, playsinline: 1, rel: 0, iv_load_policy: 3},
            events: {
              onReady: () => { this.status = 'ready'; try { this.player.setVolume(this.volume); } catch { /* retried on next change */ } resolve(); },
              onStateChange: e => this.onState(e.data),
              onError: e => this.onError(e.data),
            },
          });
          if (!this.player) reject(new Error('no player'));
        });
        this.emit();
        return true;
      } catch (error) {
        this.player = null;
        this.fail(error);
        return false;
      } finally { this.loading = null; }
    })();
    return this.loading;
  }
  onState(code) {
    if (code === STATE.PLAYING) { this.playing = true; this.errorRun = 0; }
    else if (code === STATE.PAUSED || code === STATE.ENDED) this.playing = false;
    if (code === STATE.ENDED && this.wantPlay) { this.next(); return; }
    this.emit();
  }
  // Embedding refused / video removed: skip to the next track, give up once the whole list has failed in a row.
  onError() {
    this.playing = false;
    if (++this.errorRun >= this.playlist.length) { this.fail(); return; }
    if (this.wantPlay) this.next(); else this.emit();
  }
  snapshot() {
    return {enabled: this.enabled, status: this.status, playing: this.playing, volume: this.volume, index: this.index, title: this.track.title};
  }
}
