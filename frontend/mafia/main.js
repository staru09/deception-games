// Loads a game, polls it while it is live, runs the playback clock, and wires
// state.js to ui.js and to the 3D scene (see CONTRACT.md).
//
// URL parameters: game=<id>  scene=off  at=<n>|end  speed=1|4|16  reveal=1  card=<name>
//                 skin=robots  tod=day|night  follow=1  sheet=open  still=1
import { initialState, apply, toSnapshot, completeLines, liveness } from './state.js';
import { createUI, showEmpty } from './ui.js';

const q = new URLSearchParams(location.search);
if (q.get('still') === '1') document.documentElement.classList.add('still');   // no CSS motion, for screenshots
// Holds used only while following a live game (a replay at 1× keeps the real gaps):
const MIN_GAP = 0.35;   // seconds between two events, so a burst written at once stays readable
const DEATH_HOLD = 2;   // the same after an elimination or a save: the engine writes the next phase in the same instant
const POLL_MS = 1000;
const INDEX_EVERY = 5;  // a live game re-reads index.json on every fifth poll: only the index says "aborted"
const QUIET_S = 600;    // a game index.json does not list is given up on after this long without an event
const SCENE_WAIT_MS = 6000;   // a replay waits this long for the village before it starts anyway

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url, as = 'json') {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res[as]();
}

// The most recent game, preferring one that is still running.
function latest(index) {
  const recent = [...index].sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
  return (recent.find((g) => g.winner === null) ?? recent[0])?.id ?? null;
}

// The scene is optional: this stand-in has the same methods and does nothing.
const NO_SCENE = Object.fromEntries(
  ['sync', 'handle', 'setReveal', 'setSkin', 'setTimeOfDay', 'setFollowSpeaker', 'setSpeed', 'focus'].map((m) => [m, () => {}]));

async function boot() {
  const index = await get('games/index.json').then((x) => (Array.isArray(x) ? x : []), () => []);   // 404 before the first game
  const id = q.get('game') || latest(index);
  if (id == null) return showEmpty('none');
  const base = `games/${encodeURIComponent(id)}/`;
  const config = await get(base + 'config.json').catch(() => null);
  if (!Array.isArray(config?.players)) return showEmpty('missing', id);
  document.title = `Game ${id} · LLMafia`;
  return run(String(id), base, config, index);
}

async function run(id, base, config, index) {
  let entry = index.find((g) => String(g.id) === id);   // this game's line in index.json, if it has one
  const start = initialState(config);
  const players = start.order.map((name) => start.players[name]);   // seat order, colours from PALETTE

  const events = [];      // every complete line of events.jsonl so far
  const times = [];       // their ts, made safe
  const playAt = [];      // when each plays, in seconds at 1×: see gapBefore()
  let linesRead = 0;
  let timeline = { segs: [], marks: [] };

  let state = start;
  let cursor = 0;         // events applied: state === events.slice(0, cursor).reduce(apply, start)
  let virt = 0;           // the playback clock, on the playAt scale
  let playing = false;
  let dragging = false;
  let live = false;       // the game is still being played
  let following = false;  // playback has caught up with a live game and now shows events as they arrive
  let wait = 0;           // while following: seconds until the next event may show
  let skew = 0;           // server clock minus ours, when they clearly differ
  let ahead = -Infinity;  // the largest sample of that difference so far
  let polls = 0;

  let speed = [1, 4, 16].includes(+q.get('speed')) ? +q.get('speed') : 1;
  let reveal = q.get('reveal') === '1';
  let skin = q.get('skin') === 'robots' ? 'robots' : 'villagers';
  let tod = ['day', 'night'].includes(q.get('tod')) ? q.get('tod') : null;
  let follow = q.get('follow') === '1';

  let scene = NO_SCENE;
  let sentReveal = false;   // the scene's default
  // A scene bug must never take the viewer down with it.
  const call = (method, ...args) => {
    try { scene[method]?.(...args); } catch (err) { console.warn(`scene.${method} failed:`, err); }
  };

  // ---------- data ----------

  function ingest(text) {
    const lines = completeLines(text);   // a half-written last line waits for the next poll
    const before = events.length;
    for (const line of lines.slice(linesRead)) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (typeof ev?.type !== 'string') continue;
      times.push(Number.isFinite(ev.ts) ? ev.ts : times.at(-1) ?? 0);
      events.push(ev);
      playAt.push(events.length > 1 ? playAt.at(-1) + gapBefore(events.length - 1) : 0);
    }
    linesRead = Math.max(linesRead, lines.length);
    if (events.length > before) timeline = bands();
    return events.length - before;
  }

  // The least time that event i stays on stage before the next one, when following a live game.
  const holdAfter = (i) => (events[i].type === 'eliminated' || events[i].type === 'saved' ? DEATH_HOLD : MIN_GAP);
  // Seconds at 1× to wait before event i: exactly the real gap, so a replay at 1× takes as long
  // as the game did (4× and 16× for faster). Town view waits through the mafia's night too.
  const gapBefore = (i) => Math.max(0, times[i] - times[i - 1]);

  // ponytail: refetches the whole file every poll. Fine for a few hundred events; use Range requests if logs grow.
  async function pull() {
    try {
      const res = await fetch(base + 'events.jsonl', { cache: 'no-store' });
      if (!res.ok) return 0;   // not written yet
      // The header is cut to whole seconds, so every sample is up to 1 s short and the largest is the
      // closest. Taking each poll's own sample made the countdown jump by a second every few polls.
      const diff = Date.parse(res.headers.get('date') ?? '') / 1000 - Date.now() / 1000;
      if (diff > ahead) ahead = diff;   // NaN compares false
      skew = Math.abs(ahead) > 2 ? ahead : 0;
      return ingest(await res.text());
    } catch {
      return null;   // the request failed: this poll says nothing about the game
    }
  }

  // 'live' | 'over' | 'aborted' | 'quiet', see liveness() in state.js. Silence is measured on the server's
  // clock from the last event, or from when this page opened while there is no event yet.
  const status = () => liveness({
    lastEvent: events.at(-1), entry, quietS: QUIET_S,
    idleS: times.length ? Date.now() / 1000 + skew - times.at(-1) : performance.now() / 1000,
  });

  // The launcher rewrites index.json when a game starts, ends or is aborted.
  async function readIndex() {
    const next = await get('games/index.json').catch(() => null);
    if (!Array.isArray(next)) return;   // missing or unreadable this time: keep what we have
    const changed = JSON.stringify(next) !== JSON.stringify(index);
    index = next;
    entry = index.find((g) => String(g.id) === id);
    if (changed) ui.setGames(index, id, reveal);   // not on every read: that would close an open picker
  }

  async function poll() {
    // The index first: the launcher writes a game's result after its last event, so the events
    // read after it are complete.
    if (++polls % INDEX_EVERY === 0) await readIndex();
    const added = await pull();
    const now = status();
    if (live && added !== null && now !== 'live') {   // game_over arrived, or the game was aborted or went quiet: stop polling
      live = false;
      if (entry && now === 'over') entry.winner ??= events.at(-1).winner;   // the picker need not wait for the launcher
      ui.setGames(index, id, reveal);
    }
    if (added || !live) render();
    if (live) setTimeout(poll, POLL_MS);
  }

  // Day/night bands and death markers for the scrubber.
  function bands() {
    const segs = [], marks = [];
    events.forEach((e, i) => {
      if (e.type === 'phase') segs.push({ at: i, phase: e.phase === 'night' ? 'night' : 'day' });
      else if (e.type === 'eliminated') marks.push({ at: i + 1, kind: 'death' });
      else if (e.type === 'game_over') marks.push({ at: i + 1, kind: 'over' });
    });
    return { segs, marks };
  }

  // ---------- playback ----------

  const god = () => reveal || state.winner !== null;   // after game_over everything is shown
  function pushReveal() {
    if (god() !== sentReveal) call('setReveal', (sentReveal = god()));
  }

  function render() {
    const end = status();
    ui.render({
      state, god: god(), locked: state.winner !== null, cursor, total: events.length, playing, speed, live,
      atEdge: following && playing, timeline, now: gameTs(),
      halt: !live && (end === 'aborted' || end === 'quiet') ? end : null,   // why it stopped without a winner
    });
  }

  // Forward by one event, animated.
  function step() {
    const ev = events[cursor++];
    state = apply(state, ev);
    call('handle', ev);
    pushReveal();
    return ev;
  }

  // Jump anywhere: rebuild from event 0 (a game has a few hundred events) and resync the scene.
  function seek(to) {
    hushVoice();
    following = false;
    cursor = clamp(Math.round(to) || 0, 0, events.length);
    state = events.slice(0, cursor).reduce(apply, start);
    virt = cursor ? playAt[cursor - 1] : 0;
    pushReveal();
    call('sync', toSnapshot(state));
    ui.clearToast();
    render();
  }

  function goLive() {
    seek(events.length);
    following = true;
    wait = 0;   // whatever arrives next plays at once
    playing = true;
    render();
  }

  function advance(dt) {
    const n = events.length, fired = [];
    if (following) {
      // At the live edge the present counts, not the recorded rhythm: an event shows as soon as it
      // has arrived and the one before it has had its hold. Replaying the real gaps here kept every
      // event as late as the slowest poll before it, and the clock jumped back with each arrival.
      // ponytail: one event per hold, so a game writing more than about 3 events a second falls behind; drain faster if one ever does.
      wait -= dt;
      if (cursor < n && wait <= 0) {
        fired.push(step());
        wait = holdAfter(cursor - 1) / speed;
        virt = playAt[cursor - 1];
      }
    } else {
      virt += dt * speed;
      while (cursor < n && playAt[cursor] <= virt) fired.push(step());
    }
    let changed = fired.length > 0;
    if (cursor === n && !live) {   // the end of a finished game
      following = false;
      playing = false;
      changed = true;
    } else if (cursor === n && !following) {   // caught up with a live game: from here on, follow it
      following = true;
      wait = n ? holdAfter(n - 1) / speed : 0;
      changed = true;
    }
    if (changed) {
      render();
      fired.forEach((ev) => { ui.announce(ev); speak(ev); });
    }
  }

  // ---------- the moderator's voice ----------
  // A narration event has `audio` (an mp3 in the game dir) when the game had a voice. The clips
  // play one after another, only from playback at 1×: a seek, a step or a pause stays silent.
  let voiceOn = q.get('voice') !== '0';
  const clips = [];
  const voice = new Audio();
  voice.addEventListener('ended', () => nextClip());
  // The browser blocks sound until the page has been clicked once, and a replay starts by itself.
  // A blocked clip is kept: the speaker button asks for a click, and the first click plays it.
  let voiceBlocked = false;
  function nextClip() {
    const src = clips.shift();
    if (!src) return;
    voice.src = src;
    voice.play().catch((e) => {
      if (e.name !== 'NotAllowedError') return nextClip();   // a missing or broken clip: skip it
      clips.length = 0;
      voiceBlocked = true;
      ui.setVoiceBlocked(true);
    });
  }
  function unblockVoice() {
    if (!voiceBlocked) return;
    voiceBlocked = false;
    ui.setVoiceBlocked(false);
    if (voiceOn && playing && speed === 1) voice.play().catch(() => {});   // the line it missed
  }
  addEventListener('pointerdown', unblockVoice);
  addEventListener('keydown', unblockVoice);
  function speak(ev) {
    if (ev.type !== 'narration' || !ev.audio || !voiceOn || speed !== 1) return;
    clips.push(base + ev.audio);
    if (voice.paused) nextClip();
  }
  function hushVoice() { clips.length = 0; voice.pause(); }

  // Playback time on the events' own clock. Between two events it moves in proportion, so the
  // countdown stays continuous. While following a live game it is the present, also in the
  // moment between an event's arrival and its turn to show.
  function gameTs() {
    if (!cursor) return times[0] ?? 0;
    const a = times[cursor - 1];
    if (following && playing) return Math.max(a, Date.now() / 1000 + skew);
    if (cursor === events.length) return a;
    const span = playAt[cursor] - playAt[cursor - 1];   // 0 for events written in the same instant
    const part = span > 0 ? (virt - playAt[cursor - 1]) / span : 1;
    return a + (times[cursor] - a) * clamp(part, 0, 1);
  }

  let lastFrame = performance.now();
  function frame() {
    const t = performance.now();
    const dt = clamp((t - lastFrame) / 1000, 0, 0.25);
    lastFrame = t;
    if (playing && !dragging) advance(dt);
    ui.tick(gameTs());
  }
  const loop = () => { frame(); requestAnimationFrame(loop); };

  // ---------- interface ----------

  const ui = createUI({
    players,
    initial: { skin, follow, voice: q.get('voice') !== '0', sheet: q.get('sheet') === 'open' },
    on: {
      toggle() {
        if (playing) { playing = false; following = false; hushVoice(); }   // on resume it plays on from here; LIVE jumps to the present
        else {
          if (!live && cursor === events.length) seek(0);   // replay
          playing = true;
        }
        render();
      },
      step(dir) {
        playing = false;
        if (dir < 0) return seek(cursor - 1);
        following = false;
        if (cursor === events.length) return render();
        const ev = step();
        virt = playAt[cursor - 1];
        render();
        ui.announce(ev);
      },
      scrub(to) { dragging = true; seek(to); },
      scrubEnd() { dragging = false; },
      live: goLive,
      speed(n) { speed = n; if (n !== 1) hushVoice(); call('setSpeed', n); render(); },
      voice(value) { voiceOn = value; if (!value) hushVoice(); },
      reveal(value) { reveal = value; pushReveal(); ui.setGames(index, id, reveal); render(); },
      skin(name) { skin = name; call('setSkin', name); },
      follow(value) { follow = value; call('setFollowSpeaker', value); },
      focus(name) { call('focus', name); },
      card(name) { call('focus', name); },
      game(next) {
        const url = new URL(location.href);
        url.search = '';
        url.searchParams.set('game', next);
        if (q.has('scene')) url.searchParams.set('scene', q.get('scene'));
        location.assign(url);
      },
    },
  });
  ui.setGames(index, id, reveal);

  // ---------- the 3D scene ----------

  async function loadScene() {
    if (q.get('scene') === 'off') return ui.setScene('off');
    ui.setScene('loading');
    const container = document.getElementById('scene');
    try {
      const { createScene } = await import('./scene.js');
      const made = await createScene(container, {
        players: players.map(({ name, model, role, color }) => ({ name, model, role, color })),
        onPlayerClick: (name) => ui.openCard(name),
      });
      scene = made;
      // Bring it up to date with whatever was chosen while it loaded, then show the current moment.
      if (speed !== 1) call('setSpeed', speed);
      if (skin !== 'villagers') call('setSkin', skin);
      if (tod) call('setTimeOfDay', tod);
      if (follow) call('setFollowSpeaker', true);
      sentReveal = false;   // a new scene starts in town view, whatever the stand-in was told
      pushReveal();
      call('sync', toSnapshot(state));
      ui.setScene('ready');
    } catch (err) {
      console.warn('3D scene unavailable, continuing without it:', err);
      container.replaceChildren();
      ui.setScene('failed');
    }
  }

  // ---------- start ----------

  await pull();
  live = status() === 'live';
  const sceneLoaded = loadScene();
  requestAnimationFrame(loop);
  // Animation frames ignore a fast-forwarded clock (headless Chrome's --virtual-time-budget) but
  // timers follow it, so this second, slower beat lets a screenshot catch a replay mid-game.
  setInterval(() => { if (!document.hidden) frame(); }, 100);

  let edgeWhenHidden = false;   // a hidden tab stops animating; catch up on return
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) edgeWhenHidden = following && playing;
    else if (edgeWhenHidden && cursor < events.length) goLive();
  });

  const at = q.get('at');
  if (at !== null) seek(at === 'end' ? events.length : Number(at));   // paused there
  else if (live) goLive();
  else seek(0);
  if (q.get('card')) ui.openCard(q.get('card'), { focus: false });
  if (live) setTimeout(poll, POLL_MS);

  if (at === null && !live) {   // a finished game replays from the start
    await Promise.race([sceneLoaded, sleep(SCENE_WAIT_MS)]);
    playing = true;
    render();
  }
}

boot().catch((err) => {
  console.error(err);
  showEmpty('error', err?.message ?? err);
});
