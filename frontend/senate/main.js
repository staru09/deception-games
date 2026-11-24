// Senate viewer entry: /senate/?game=<id>&at=<n>|end&speed=1|4|16&god=0|1
import { loadGame, startReplay } from '../common/replay.js';
import { init, apply } from './state.js';
import { render } from './ui.js';

const game = await loadGame();
if (game.empty) {
  const box = document.getElementById('empty');
  box.hidden = false;
  box.textContent = game.empty === 'none' ? 'No Senate games yet.' : `Game ${game.id} was not found.`;
} else {
  document.getElementById('app').hidden = false;
  startReplay({ game, controls: document.getElementById('controls'), init, apply, render, godLabel: 'God view' });
}
