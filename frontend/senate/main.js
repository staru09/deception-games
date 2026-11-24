// Senate viewer entry: /senate/?game=<id>&at=<n>|end&speed=1|4|16&god=0|1&scene=off
// The 3D chamber (scene.js) is optional: without WebGL, when the CDN fails, or with scene=off the
// 2D board of ui.js shows instead, and the transcript and replay controls work the same either way.
import { loadGame, startReplay } from '../common/replay.js';
import { init, apply } from './state.js';
import { render as renderUi } from './ui.js';

const SCENE_WAIT_MS = 8000;   // a replay starts without the chamber if it takes longer than this to load
const q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

const game = await loadGame();
if (game.empty) {
  const box = $('empty');
  box.hidden = false;
  box.textContent = game.empty === 'none' ? 'No Senate games yet.' : `Game ${game.id} was not found.`;
} else {
  const app = $('app');
  app.hidden = false;
  let scene = null, last = null;
  const render = (s, ctx) => { last = [s, ctx]; renderUi(s, ctx, !!scene); scene?.update(s, ctx); };
  const redraw = () => last && render(last[0], { ...last[1], fired: [], cursor: -1 });   // a full redraw of the current moment
  const without = (err) => {
    if (err) console.warn('3D chamber unavailable, showing the 2D board instead:', err);
    app.classList.add('no-scene');
    redraw();
  };
  const loading = q.get('scene') === 'off' ? Promise.resolve(without()) : import('./scene.js')
    .then((m) => m.createScene($('scene'), { players: game.config.players.map((p) => ({ name: p.name })) }))
    .then((made) => { scene = made; $('placeholder').hidden = true; redraw(); }, without);
  await Promise.race([loading, new Promise((r) => setTimeout(r, SCENE_WAIT_MS))]);
  startReplay({ game, controls: $('controls'), init, apply, render, godLabel: 'God view' });
}
