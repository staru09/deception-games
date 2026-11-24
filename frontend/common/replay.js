// Playback for the 2D arena viewers (Senate, Poker). It loads a game, polls events.jsonl while the
// game is live, and plays the events through the game's reducer at 1×, 4× or 16×, with a scrubber,
// LIVE, and a god-view toggle. Town view applies only events without "spoiler": true.
//
//   const game = await loadGame();                   // ?game=<id>, else the live or latest game
//   if (game.empty) ... show "no games" / "game not found"
//   startReplay({ game, controls: element, init, apply, render, godLabel, godDefault });
//
//   init(config)        -> a fresh state (called again on every seek, so apply may mutate it)
//   apply(state, event) -> the state after the event
//   render(state, ctx)  -> draw; ctx = { god, cursor, total, live, following, playing, speed,
//                          fired: [events played since the last render], events, config, id,
//                          halt: null | 'aborted' | 'quiet', seek(i) }
//
// URL parameters: game=<id>  at=<n>|end  speed=1|4|16  god=0|1
// See docs/ARENA_CONTRACT.md.

const MIN_GAP = 0.35;   // seconds at 1× between two events of a replay, at least...
const MAX_GAP = 2.5;    // ...and at most: the real gaps are model latency, often 10 s or more
const LIVE_HOLD = 0.6;  // following a live game: the least time an event stays before the next
const POLL_MS = 1000;
const INDEX_EVERY = 5;  // a live game re-reads index.json every fifth poll: only the index says "aborted"
const QUIET_S = 600;    // a game index.json does not list is given up on after this long without an event
const SPEEDS = [1, 4, 16];

const q = new URLSearchParams(location.search);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Lines of a JSONL file that may still be being appended to: a last line counts once it ends in "\n".
export const completeLines = (text) =>
  text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter((line) => line.trim());

// 'live' | 'over' | 'aborted' | 'quiet', as in the Mafia viewer.
export function liveness({ lastEvent, entry, idleS, quietS = QUIET_S }) {
  if (lastEvent?.type === 'game_over') return 'over';   // the events are the truth, whatever the index says
  if (entry?.winner === 'aborted') return 'aborted';
  if (entry?.winner != null) return 'over';
  return entry == null && idleS > quietS ? 'quiet' : 'live';
}

async function get(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

export async function loadGame() {
  const index = await get('games/index.json').then((x) => (Array.isArray(x) ? x : []), () => []);
  const recent = [...index].sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
  const id = q.get('game') || (recent.find((g) => g.winner === null) ?? recent[0])?.id;
  if (id == null) return { empty: 'none' };
  const base = `games/${encodeURIComponent(id)}/`;
  const config = await get(base + 'config.json').catch(() => null);
  if (!Array.isArray(config?.players)) return { empty: 'missing', id: String(id) };
  return { id: String(id), base, config, index };
}

const ICONS = {
  back: '<path d="M6 5h2v14H6zM20 5v14L9 12z"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
  fwd: '<path d="M16 5h2v14h-2zM4 5v14l11-7z"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

export async function startReplay({ game, controls, init, apply, render, godLabel = 'God view', godDefault = false }) {
  const { id, base, config } = game;
  let index = game.index;
  let entry = index.find((g) => String(g.id) === id);
  const events = [];
  let linesRead = 0;
  let cursor = 0;          // events applied (hidden ones included)
  let state = init(config);
  let wait = 0;            // seconds at 1× until the next event may play
  let fired = [];
  let playing = false, live = false, following = false, halt = null, polls = 0;
  let speed = SPEEDS.includes(+q.get('speed')) ? +q.get('speed') : 1;
  let god = q.has('god') ? q.get('god') === '1' : godDefault;

  const visible = (ev) => god || !ev.spoiler;
  const ts = (i) => (Number.isFinite(events[i]?.ts) ? events[i].ts : 0);
  // seconds at 1× between event i-1 and event i; hidden events take no time
  const gapTo = (i) => (i <= 0 || i >= events.length || !visible(events[i]) ? 0
    : following ? LIVE_HOLD : clamp(ts(i) - ts(i - 1), MIN_GAP, MAX_GAP));

  // ---------- data ----------

  function ingest(text) {
    const lines = completeLines(text);
    const before = events.length;
    for (const line of lines.slice(linesRead)) {
      try {
        const ev = JSON.parse(line);
        if (typeof ev?.type === 'string') events.push(ev);
      } catch { /* a broken line is skipped */ }
    }
    linesRead = Math.max(linesRead, lines.length);
    return events.length - before;
  }

  async function pull() {
    try {
      const res = await fetch(base + 'events.jsonl', { cache: 'no-store' });
      return res.ok ? ingest(await res.text()) : 0;   // 404: not written yet
    } catch {
      return null;   // the request failed: this poll says nothing about the game
    }
  }

  const status = () => liveness({ lastEvent: events.at(-1), entry, idleS: Date.now() / 1000 - (ts(events.length - 1) || Date.now() / 1000) });

  async function poll() {
    if (++polls % INDEX_EVERY === 0) {   // the launcher writes the result after the last event
      const next = await get('games/index.json').catch(() => null);
      if (Array.isArray(next)) { index = next; entry = index.find((g) => String(g.id) === id); }
    }
    const added = await pull();
    const now = status();
    if (added !== null && now !== 'live') {
      live = false;
      halt = now === 'aborted' || now === 'quiet' ? now : null;
    }
    if (added || !live) draw();
    if (live) setTimeout(poll, POLL_MS);
  }

  // ---------- playback ----------

  function step() {
    const ev = events[cursor++];
    if (visible(ev)) { state = apply(state, ev); fired.push(ev); }
    return ev;
  }

  function seek(to) {
    following = false;
    cursor = clamp(Math.round(to) || 0, 0, events.length);
    state = events.slice(0, cursor).filter(visible).reduce(apply, init(config));
    fired = [];
    wait = gapTo(cursor);
    draw();
  }

  function goLive() {
    seek(events.length);
    following = playing = true;
    draw();
  }

  function advance(dt) {
    wait -= dt * speed;
    while (cursor < events.length && wait <= 0) {
      step();
      wait += gapTo(cursor);
    }
    if (cursor === events.length) {
      wait = Math.max(wait, 0);   // an event that arrives later plays at once, then holds
      if (!live) playing = false;
      else following = true;
    }
    if (fired.length || !playing) draw();
  }

  // ---------- controls ----------

  controls.innerHTML = `<div class="rp">
    <button type="button" data-a="back" aria-label="Previous event">${icon('back')}</button>
    <button type="button" data-a="play" aria-label="Play">${icon('play')}</button>
    <button type="button" data-a="fwd" aria-label="Next event">${icon('fwd')}</button>
    <input type="range" min="0" max="0" value="0" aria-label="Position in the game">
    <span class="rp-pos"></span>
    <span class="rp-speed" role="group" aria-label="Speed">${SPEEDS.map((s) =>
      `<button type="button" data-speed="${s}">${s}×</button>`).join('')}</span>
    <button type="button" class="rp-live" data-a="live" title="Jump to the present">LIVE</button>
    <span class="rp-halt" role="status"></span>
    <label class="rp-god"><input type="checkbox"> ${godLabel}</label>
  </div>`;
  const $ = (sel) => controls.querySelector(sel);
  const scrub = $('input[type=range]'), godBox = $('.rp-god input'), playBtn = $('[data-a=play]');

  controls.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.speed) { speed = +b.dataset.speed; return draw(); }
    ({ back, play: toggle, fwd, live: goLive })[b.dataset.a]?.();
  });
  scrub.addEventListener('input', () => seek(+scrub.value));
  godBox.addEventListener('change', () => { god = godBox.checked; seek(cursor); });
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, select, textarea, button') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') back();
    else if (e.key === 'ArrowRight') fwd();
  });

  function toggle() {
    if (playing) { playing = following = false; }
    else {
      if (cursor === events.length && !live) seek(0);   // replay from the start
      playing = true;
    }
    draw();
  }
  function back() {
    playing = false;
    let j = cursor - 1;
    while (j > 0 && !visible(events[j])) j--;
    seek(Math.max(j, 0));
  }
  function fwd() {
    playing = following = false;
    while (cursor < events.length && !visible(step()));
    wait = gapTo(cursor);
    draw();
  }

  function draw() {
    scrub.max = events.length;
    scrub.value = cursor;
    $('.rp-pos').textContent = `${cursor} / ${events.length}`;
    playBtn.innerHTML = icon(playing ? 'pause' : 'play');
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    controls.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.speed === speed)));
    const live$ = $('.rp-live');
    live$.hidden = !live;
    live$.setAttribute('aria-pressed', String(following && playing));
    $('.rp-halt').textContent = halt === 'aborted' ? 'Game aborted' : halt === 'quiet' ? 'No news for 10 minutes' : '';
    godBox.checked = god;
    const played = fired;
    fired = [];
    render(state, { god, cursor, total: events.length, live, following, playing, speed, fired: played,
      events, config, id, halt, seek: (i) => { playing = false; seek(i); } });
  }

  // ---------- start ----------

  let last = performance.now();
  setInterval(() => {   // timers, not animation frames: they also run in headless screenshots
    const t = performance.now();
    const dt = clamp((t - last) / 1000, 0, 0.25);
    last = t;
    if (playing) advance(dt);
  }, 50);
  let edgeWhenHidden = false;   // a hidden tab is throttled; catch up on return
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) edgeWhenHidden = following && playing;
    else if (edgeWhenHidden && cursor < events.length) goLive();
  });

  await pull();
  live = status() === 'live';
  halt = live ? null : status() === 'over' ? null : status();
  const at = q.get('at');
  if (at !== null) seek(at === 'end' ? events.length : Number(at));
  else if (live) goLive();
  else { seek(0); playing = true; draw(); }
  if (live) setTimeout(poll, POLL_MS);
}
