// Poker viewer entry: loads a game and starts the shared replay (../common/replay.js).
// URL parameters: game=<id>  at=<n>|end  speed=1|4|16  god=0|1   (god = broadcast view: hole cards shown)
import { loadGame, startReplay } from '../common/replay.js';
import { init, apply } from './state.js';
import { render } from './ui.js';

const $ = (id) => document.getElementById(id);

function showEmpty(title, text) {
  $('empty-title').textContent = title;
  $('empty-text').textContent = text;
  $('empty').hidden = false;
}

const game = await loadGame();
if (game.empty === 'none') showEmpty('No poker games yet', 'Launch one from the dashboard; it appears here as soon as it starts.');
else if (game.empty) showEmpty('Game not found', `There is no poker game "${game.id}" on this server.`);
else {
  document.title = `Game ${game.id} · Poker`;
  $('sub').textContent = `Game ${game.id}`;
  $('app').hidden = false;
  startReplay({ game, controls: $('controls'), init, apply, render, godLabel: 'Broadcast view', godDefault: true });
}
