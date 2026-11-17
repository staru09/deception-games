// The 2D interface: top bar, chat thread, roster, player card, timeline, banners. DOM only.
//
// Every name, model id, chat message and reasoning trace is LLM output. Game text only ever
// reaches the page as text nodes (textContent / append); nothing here builds HTML from strings.
//
// Spoilers (CONTRACT.md): `god` is true in god view and after game_over. When it is false,
// nothing about a living player's role is put in the DOM at all, not merely hidden with CSS.
import { aliveCounts } from './state.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ROLES = new Set(['mafia', 'detective', 'doctor', 'villager']);
const keep = (kids) => kids.flat(2).filter((k) => k != null && k !== false && k !== '');

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...keep(kids));
  return el;
}
const fill = (el, ...kids) => el.replaceChildren(...keep(kids));

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

const shortModel = (id) => id.slice(id.lastIndexOf('/') + 1);
const phaseName = (phase, round) => `${phase === 'night' ? 'Night' : 'Day'} ${round}`;
const phaseShort = (phase, round) => (phase === 'night' ? 'N' : 'D') + round;
export const clock = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Shown instead of the viewer when there is nothing to open.
export function showEmpty(kind, id) {
  const text = {
    none: ['No games yet', 'Start a game from the backend folder, then reload this page.', 'cd backend\npython run_autonomous.py <table config>'],
    missing: [`Game “${id}” was not found`, 'There is no config.json for it in the games directory.', null],
    error: ['The viewer could not start', String(id ?? ''), null],
  }[kind];
  $('app').hidden = true;
  $('empty').hidden = false;
  $('empty-title').textContent = text[0];
  $('empty-text').textContent = text[1];
  $('empty-code').hidden = !text[2];
  $('empty-code').textContent = text[2] ?? '';
  $('empty-more').hidden = kind !== 'missing';
  if (kind === 'missing') fill($('empty-more'), h('a', { href: './', text: 'Open the most recent game' }));
}

export function createUI({ players, on, initial = {} }) {
  const byName = new Map(players.map((p) => [p.name, p]));
  const app = $('app'), thread = $('thread'), scrub = $('scrub'), card = $('card');
  let view = null;          // the last render() argument
  let now = 0;              // playback time in game seconds (event ts scale)
  let drawn = { count: 0, last: null, god: null };   // what the thread currently shows
  let section = null;       // the thread's current Day/Night group
  let drawnTimeline = null;
  let cardName = null, opener = null;

  $('empty').hidden = true;
  app.hidden = false;

  // ---------- small pieces ----------

  const colorOf = (name) => byName.get(name)?.color ?? '#7b8496';
  function dot(name, cls = '') {
    const d = h('span', { class: 'dot ' + cls });
    d.style.setProperty('--pc', colorOf(name));
    return d;
  }
  // A player's name as a button that opens their card. Names we do not know stay plain text.
  function pname(name) {
    if (!byName.has(name)) return h('span', { class: 'pname unknown', text: String(name) });
    const b = h('button', { type: 'button', class: 'pname', text: name, onclick: (e) => { e.stopPropagation(); openCard(name); } });
    b.style.setProperty('--pc', colorOf(name));
    return b;
  }
  const roleClass = (role) => 'role role-' + (ROLES.has(role) ? role : 'other');
  const roleTag = (role) => h('span', { class: roleClass(role), text: role });
  const tag = (text, cls) => h('span', { class: 'tag ' + cls, text });
  const died = (st) => `${st.cause === 'night' ? 'Killed' : 'Voted out'} on ${phaseName(st.diedIn.phase, st.diedIn.round).toLowerCase()}`;
  // A game that stopped without a winner, watched to its last event. view.halt says why:
  // 'aborted' (the launcher stopped it) or 'quiet' (nobody tracks it and it has long been silent).
  const stopped = () => view.halt && !view.state.winner && view.cursor === view.total;
  const HALT = {
    aborted: ['Game aborted', 'It stopped before either side won'],
    quiet: ['Game stalled', 'Nothing has happened in it for a long time'],
  };
  // The open vote, as far as this view may see it (night votes are the mafia's).
  const openVotes = () => (view.state.voting && (view.state.phase === 'day' || view.god) ? view.state.votes : []);

  // ---------- top bar ----------

  function renderTop() {
    const { state: s, god, locked, live } = view;
    app.dataset.phase = s.phase;
    app.dataset.view = god ? 'god' : 'town';
    $('phase-name').textContent = s.winner ? (s.winner === 'mafia' ? 'Mafia wins' : 'Town wins') : stopped() ? HALT[view.halt][0]
      : s.started ? phaseName(s.phase, s.round) : live ? 'Waiting for the game' : 'Before the game';
    renderClock();
    const { town, mafia } = aliveCounts(s);
    $('n-town').textContent = town;
    $('n-mafia').textContent = mafia;
    const reveal = $('reveal');
    reveal.setAttribute('aria-pressed', String(god));
    reveal.setAttribute('aria-disabled', String(locked));
    reveal.title = locked ? 'The game is over: all roles are public' : 'Reveal roles (god view)';
    $('view-badge').textContent = locked ? 'All revealed' : god ? 'God view' : 'Town view';
  }

  function renderClock() {
    const { state: s, god } = view;
    let text = '';
    if (s.winner || !s.started || stopped()) text = '';
    else if (s.voting && (s.phase === 'day' || god)) text = 'voting';
    else if (s.duration > 0 && (s.discussion || s.voting)) {   // a night vote is the mafia's secret: town view just keeps counting
      const left = s.phaseTs + s.duration - now;
      text = left > 0 ? `${clock(Math.ceil(left))} left` : s.phase === 'day' ? 'time is up' : '';
    }
    const el = $('phase-clock');
    if (el.textContent !== text) el.textContent = text;
  }

  function setGames(index, current, showWinners) {
    const games = [...index].sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
    if (!games.some((g) => String(g.id) === current)) games.unshift({ id: current });
    fill($('picker'), games.map((g) => {
      // Winners are spoilers: they only show once roles are revealed.
      const status = g.winner === undefined ? '' : g.winner === null ? 'live' : g.winner === 'aborted' ? 'aborted'
        : showWinners ? `${g.winner} won` : 'finished';
      const date = g.started ? new Date(g.started * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      return h('option', { value: String(g.id), text: [`Game ${g.id}`, date, status].filter(Boolean).join(' · ') });
    }));
    $('picker').value = current;
  }

  // ---------- roster ----------

  const chips = new Map();
  for (const p of players) {
    const c = {
      votes: h('span', { class: 'chip-votes', hidden: true }),
      role: h('span', { class: 'role', hidden: true }),
      sub: h('span', { class: 'chip-sub' }),
    };
    c.el = h('button', { type: 'button', class: 'chip', onclick: () => openCard(p.name) },
      dot(p.name), h('span', { class: 'chip-name', text: p.name }), c.votes,
      h('span', { class: 'chip-line' }, c.role, c.sub));
    c.el.style.setProperty('--pc', p.color);
    chips.set(p.name, c);
    $('roster').append(c.el);
  }

  function renderRoster() {
    const { state: s, god } = view, votes = openVotes();
    for (const p of players) {
      const st = s.players[p.name], c = chips.get(p.name);
      const role = god || !st.alive ? st.role : null;
      const mine = st.alive && votes.find((v) => v.voter === p.name);
      const got = votes.filter((v) => v.target === p.name).length;
      c.el.classList.toggle('dead', !st.alive);
      c.role.className = role ? roleClass(role) : 'role';
      c.role.textContent = role ?? '';
      c.role.hidden = !role;
      c.votes.textContent = got || '';
      c.votes.hidden = !got;
      c.sub.textContent = !st.alive ? `out ${phaseShort(st.diedIn.phase, st.diedIn.round)}`   // D = voted out by day, N = killed at night
        : mine ? `→ ${mine.target}` : role ? '' : shortModel(p.model);
      c.sub.style.color = mine ? colorOf(mine.target) : '';
      c.el.setAttribute('aria-label', [p.name, role, st.alive ? 'alive' : died(st).toLowerCase(),
        got && `${got} vote${got > 1 ? 's' : ''} against`, mine && `voted for ${mine.target}`].filter(Boolean).join(', '));
    }
  }

  function pulse(name) {
    const el = chips.get(name)?.el;
    if (!el) return;
    el.classList.remove('speaking');
    void el.offsetWidth;   // restart the CSS animation
    el.classList.add('speaking');
  }

  // ---------- chat thread ----------

  function renderThread() {
    const { state: { entries }, god } = view;
    // Append when the thread shows a prefix of these entries; rebuild after a scrub or a view change.
    const grows = drawn.god === god && drawn.count <= entries.length
      && (drawn.count ? entries[drawn.count - 1] === drawn.last : !thread.firstChild);
    const stick = !grows || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    if (!grows) { thread.replaceChildren(); section = null; drawn.count = 0; }
    let added = false;
    for (const e of entries.slice(drawn.count)) added = appendEntry(e, god, grows) || added;
    drawn = { count: entries.length, last: entries.at(-1) ?? null, god };
    if (stick) thread.scrollTop = thread.scrollHeight;
    else if (added) $('latest').hidden = false;
    if (stick) $('latest').hidden = true;
  }

  function appendEntry(e, god, fresh) {
    if (e.spoiler && !god) return false;
    const night = e.phase === 'night';
    if (e.kind === 'phase' || !section) {
      section = h('section', { class: 'grp ' + (night ? 'night' : 'day') },
        h('h3', { class: 'grp-head' }, icon(night ? 'moon' : 'sun'), phaseName(e.phase, e.round)));
      // Same line every night, whatever happened, so it gives nothing away.
      if (night && !god) section.append(h('p', { class: 'sys quiet', text: 'The town sleeps. What happens at night is hidden in town view.' }));
      thread.append(section);
      if (e.kind === 'phase') return true;
    }
    let el;
    switch (e.kind) {
      case 'message': {
        const p = byName.get(e.name);
        el = h('div', { class: 'msg' + (night ? ' mafia' : ''), onclick: () => on.focus(e.name) },
          dot(e.name),
          h('div', { class: 'msg-main' },
            h('div', { class: 'msg-head' }, pname(e.name),
              p && h('span', { class: 'model', text: shortModel(p.model), title: p.model }),
              night && tag('mafia only', 'tag-mafia')),
            h('p', { class: 'msg-text', text: e.text })));
        break;
      }
      case 'vote_open':
        el = h('p', { class: 'sys' + (night ? ' mafia' : '') }, night ? 'The mafia choose their victim' : 'The town votes');
        break;
      case 'vote': {
        let box = section.lastElementChild;
        if (!box?.classList.contains('votes')) {
          box = h('div', { class: 'votes' + (night ? ' mafia' : '') }, night && tag('mafia only', 'tag-mafia'));
          section.append(box);
        }
        el = h('span', { class: 'vote' + (fresh ? ' fresh' : '') }, dot(e.voter), pname(e.voter),
          h('span', { class: 'arrow', text: '→' }), dot(e.target), pname(e.target));
        box.append(el);
        return true;
      }
      case 'investigate':
        el = h('p', { class: 'private' }, tag('private', 'tag-private'), pname(e.detective), ' investigated ', pname(e.target), ': ',
          h('strong', { class: e.is_mafia ? 'bad' : 'good', text: e.is_mafia ? 'mafia' : 'not mafia' }));
        break;
      case 'protect':
        el = h('p', { class: 'private' }, tag('private', 'tag-private'), pname(e.doctor),
          e.doctor === e.target ? ' protected themselves' : [' protected ', pname(e.target)]);
        break;
      case 'eliminated':
        el = h('p', { class: 'sys death' }, pname(e.name), e.cause === 'night' ? ' was killed in the night ' : ' was voted out ',
          e.role && roleTag(e.role));
        break;
      case 'saved':
        el = h('p', { class: 'sys saved' }, god ? [pname(e.name), ' was saved by the doctor'] : 'Nobody died tonight');
        break;
      case 'game_over':
        el = h('p', { class: 'sys over ' + e.winner, text: e.winner === 'mafia' ? 'Mafia wins' : 'Town wins' });
        break;
      case 'narration':
        el = h('p', { class: 'narration' }, h('span', { class: 'narrator', text: 'Moderator' }), e.text);
        break;
      default:
        return false;
    }
    if (fresh) el.classList.add('fresh');
    section.append(el);
    return true;
  }

  // ---------- timeline ----------

  const speedBtns = [...document.querySelectorAll('[data-speed]')];

  function renderTimeline() {
    const { cursor, total, playing, speed, live, atEdge, timeline } = view;
    const pct = (i) => (total ? (i / total) * 100 : 0).toFixed(2) + '%';
    scrub.max = total;
    scrub.value = cursor;
    scrub.setAttribute('aria-valuetext', `Event ${cursor} of ${total}`);
    $('track').style.setProperty('--pct', pct(cursor));
    $('pos').textContent = `${cursor} / ${total}`;
    const mode = playing ? 'pause' : !live && total && cursor === total ? 'replay' : 'play';
    $('play-icon').setAttribute('href', '#i-' + mode);
    $('play').setAttribute('aria-label', { pause: 'Pause', replay: 'Replay from the start', play: 'Play' }[mode]);
    for (const b of speedBtns) b.setAttribute('aria-pressed', String(+b.dataset.speed === speed));
    $('live').hidden = !live;
    $('live').classList.toggle('on', atEdge);
    $('live').setAttribute('aria-label', atEdge ? 'Live: showing the latest event' : 'Jump to the latest event');

    if (timeline !== drawnTimeline) {   // day/night bands and markers change only when events arrive
      drawnTimeline = timeline;
      const stops = timeline.segs.map((sg, k) => {
        const c = sg.phase === 'night' ? 'var(--night)' : 'var(--day)';
        return `${c} ${pct(sg.at)}, ${c} ${pct(timeline.segs[k + 1]?.at ?? total)}`;
      });
      $('track').style.setProperty('--segs', stops.length ? `linear-gradient(to right, ${stops.join(', ')})` : 'none');
      fill($('marks'), timeline.marks.map((m) => {
        const el = h('span', { class: 'mark ' + m.kind, 'data-at': m.at });
        el.style.left = pct(m.at);
        return el;
      }));
    }
    // A marker appears once playback has passed it, so the track never shows a death in advance.
    for (const el of $('marks').children) el.hidden = +el.dataset.at > cursor;
  }

  // ---------- banners ----------

  // Banners stack, newest last, each for its own 2.6 s. The engine writes an elimination and the next
  // phase in the same instant, so a banner that replaced the one before it left 0.35 s to read a death.
  function toast(cls, ...kids) {
    const el = h('div', { class: 'toast-item ' + cls }, kids);
    $('toast').append(el);
    while ($('toast').children.length > 3) $('toast').firstChild.remove();   // 16× can fire a dozen at once
    setTimeout(() => el.remove(), 2600);
  }
  const clearToast = () => fill($('toast'));

  // Called once per event during forward playback, after render().
  function announce(ev) {
    const god = view.god, night = ev.phase === 'night';
    switch (ev.type) {
      case 'phase': toast(night ? 'night' : 'day', icon(night ? 'moon' : 'sun'), phaseName(ev.phase, ev.round)); break;
      case 'vote_open': if (!night || god) toast(night ? 'mafia' : '', night ? 'The mafia choose their victim' : 'The town votes'); break;
      case 'eliminated': toast('death', `${ev.name} was ${ev.cause === 'night' ? 'killed in the night' : 'voted out'}`, ev.role && roleTag(String(ev.role))); break;
      case 'saved': toast('saved', god ? `${ev.name} was saved by the doctor` : 'Nobody died tonight'); break;
      case 'message': if (!night || god) pulse(ev.name); break;
      case 'game_over': clearToast(); break;
    }
  }

  function renderWinner() {
    const s = view.state;
    $('winner').hidden = !s.winner && !stopped();
    const halt = HALT[view.halt] ?? HALT.aborted;
    $('winner').className = 'winner ' + (s.winner ?? 'aborted');
    $('winner-title').textContent = s.winner === 'mafia' ? 'Mafia wins' : s.winner ? 'Town wins' : halt[0];
    $('winner-sub').textContent = s.winner ? 'All roles are revealed' : halt[1];
  }

  // ---------- player card ----------

  function openCard(name, { focus = true } = {}) {
    const p = byName.get(name);
    if (!p) return;
    cardName = name;
    $('card-name').textContent = name;
    $('card-model').textContent = p.model;
    $('card-dot').style.setProperty('--pc', p.color);
    if (!card.open) {
      opener = document.activeElement;
      card.show();
      if (!focus) document.activeElement?.blur();
    }
    renderCard();
    on.card(name);
  }

  function closeCard() {
    if (!card.open) return;
    card.close();
    cardName = null;
    if (opener?.isConnected) opener.focus();
  }

  function renderCard() {
    if (!cardName || !view) return;
    const { state: s, god } = view, st = s.players[cardName];
    const seen = (v) => god || v.phase === 'day';
    const cast = st.cast.filter(seen), got = st.received.filter(seen);
    const voteChip = (v, who) => h('span', { class: 'vote' + (v.phase === 'night' ? ' mafia' : '') },
      h('span', { class: 'when', text: phaseShort(v.phase, v.round) }), dot(who), pname(who));
    fill($('card-facts'),
      h('div', { class: 'facts' },
        god || !st.alive ? roleTag(st.role) : h('span', { class: 'role role-hidden' }, icon('lock'), 'role hidden'),
        h('span', { class: 'status ' + (st.alive ? 'alive' : 'dead'), text: st.alive ? 'Alive' : died(st) })),
      h('dl', { class: 'stats' },
        h('div', null, h('dt', { text: 'Votes cast' }), h('dd', { text: cast.length })),
        h('div', null, h('dt', { text: 'Votes received' }), h('dd', { text: got.length }))),
      cast.length > 0 && h('div', { class: 'votelist' }, h('span', { class: 'votelist-label', text: 'Voted for' }), cast.map((v) => voteChip(v, v.target))),
      got.length > 0 && h('div', { class: 'votelist' }, h('span', { class: 'votelist-label', text: 'Voted by' }), got.map((v) => voteChip(v, v.voter))));
  }

  // ---------- stage ----------

  function setScene(status) {   // 'loading' | 'ready' | 'off' | 'failed'
    const none = status === 'off' || status === 'failed';
    $('placeholder').hidden = status === 'ready';
    $('placeholder-title').textContent = { loading: 'Loading the village…', off: 'The 3D village is switched off', failed: 'The 3D village could not start' }[status] ?? '';
    $('placeholder-sub').textContent = none ? 'The chat, timeline and player cards work without it.' : '';
    for (const b of document.querySelectorAll('.needs-scene')) b.disabled = none;
    app.classList.toggle('no-scene', none);   // nothing for a clicked message to fly to
  }

  // ---------- controls ----------

  speedBtns.forEach((b) => b.addEventListener('click', () => on.speed(+b.dataset.speed)));

  $('follow').setAttribute('aria-pressed', String(!!initial.follow));
  $('follow').addEventListener('click', (e) => {
    const next = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(next));
    on.follow(next);
  });
  $('voice').setAttribute('aria-pressed', String(!!initial.voice));
  $('voice').addEventListener('click', (e) => {
    const next = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(next));
    on.voice(next);
  });
  $('reveal').addEventListener('click', () => { if (!view?.locked) on.reveal(!view?.god); });
  $('picker').addEventListener('change', (e) => on.game(e.target.value));

  $('play').addEventListener('click', () => on.toggle());
  $('prev').addEventListener('click', () => on.step(-1));
  $('next').addEventListener('click', () => on.step(1));
  $('live').addEventListener('click', () => on.live());
  scrub.addEventListener('input', () => on.scrub(+scrub.value));
  for (const type of ['change', 'pointerup', 'keyup', 'blur']) scrub.addEventListener(type, () => on.scrubEnd());

  $('card-close').addEventListener('click', closeCard);
  $('latest').addEventListener('click', () => { thread.scrollTop = thread.scrollHeight; $('latest').hidden = true; });
  thread.addEventListener('scroll', () => {
    if (thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80) $('latest').hidden = true;
  }, { passive: true });

  function setSheet(open) {   // the chat is a bottom sheet on narrow screens
    $('chat').classList.toggle('open', open);
    $('sheet-grip').setAttribute('aria-expanded', String(open));
    thread.scrollTop = thread.scrollHeight;
  }
  $('sheet-grip').addEventListener('click', () => setSheet(!$('chat').classList.contains('open')));
  if (initial.sheet) setSheet(true);

  // Space plays or pauses, the arrow keys step one event.
  let spaceTaken = false;
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (e.key === 'Escape' && card.open) return closeCard();
    if (t.closest('select, textarea, [contenteditable], input:not([type=range])')) return;
    if (e.key === ' ') {
      // A control focused from the keyboard keeps space for itself.
      if (t.closest('button, a, summary') && t.matches(':focus-visible')) return;
      e.preventDefault();
      spaceTaken = true;
      if (!e.repeat) on.toggle();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      on.step(e.key === 'ArrowRight' ? 1 : -1);
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === ' ' && spaceTaken) { e.preventDefault(); spaceTaken = false; }   // Firefox clicks a focused button on keyup
  });

  // ---------- public ----------

  function render(v) {
    view = v;
    now = v.now;
    renderTop();
    renderRoster();
    renderThread();
    renderTimeline();
    renderWinner();
    renderCard();
  }

  // Every animation frame: the countdown follows playback time.
  function tick(ts) {
    now = ts;
    if (!view) return;
    renderClock();
  }

  return { render, tick, announce, clearToast, setGames, setScene, openCard, closeCard, get cardName() { return cardName; } };
}
