// The landing page (index.html): template tabs, the project file explorer
// and the theme switch. Everything else on the page is static HTML.
const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------- Theme
// Shares the chat app's own key (gc_theme), so the choice follows you there.
$('themeToggle').addEventListener('click', () => {
  const light = document.documentElement.getAttribute('data-theme') !== 'light';
  if (light) document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('gc_theme', light ? 'light' : 'dark'); } catch { /* not saved; still applied */ }
});

// ---------------------------------------------------------------- Templates
const TEMPLATES = {
  arcade: {
    label: 'arcade',
    prompt: 'Make a neon snake arcade game: arrow keys or swipe, walls wrap around, three power-ups (speed, shrink, double points), and the speed ramps up every 5 apples.',
    thread: [
      ['You', 'Make a neon snake game with power-ups.'],
      ['Designer', 'Should the walls end the run, or wrap around?'],
      ['You', 'Wrap around.'],
      ['Builder', null, ['input: keys + swipe', 'power-ups: speed, shrink, 2×', 'best score saved']],
    ],
    points: [
      ['Builds in one go', 'A short, clear idea is enough. The designer only asks what really changes the game.'],
      ['Feels arcade-tight', 'Fixed-step game loop, speed ramps and instant restart.'],
      ['Plays on phones', 'Swipe controls come with it, so the same build works on touch screens.'],
    ],
  },
  platformer: {
    label: 'platformer',
    prompt: 'Make a side-scrolling platformer called Sky Hopper: run and double-jump across floating islands, collect gems, avoid spikes, three levels with a checkpoint in each.',
    thread: [
      ['You', 'A platformer where you hop across floating islands.'],
      ['Designer', 'How many levels, and do you want checkpoints?'],
      ['You', 'Three levels, one checkpoint each.'],
      ['Builder', null, ['scenes: title, levels 1–3, win', 'physics: gravity, double jump', 'checkpoints & lives']],
    ],
    points: [
      ['Organized into scenes', 'Title screen, each level and the win screen live in their own files.'],
      ['Real physics', 'Gravity, jump buffering and collision, tuned to feel fair.'],
      ['Easy to extend', 'Ask for a fourth level later and only the new files are written.'],
    ],
  },
  puzzle: {
    label: 'puzzle',
    prompt: 'Make a sliding tile puzzle called Tile Twist: 3×3, 4×4 and 5×5 boards, a move counter and timer, an undo button, and a best time saved for each size.',
    thread: [
      ['You', 'A sliding tile puzzle with different board sizes.'],
      ['Planner', 'Design summary: 3×3 to 5×5, moves + timer, undo, best times. Build it?'],
      ['You', 'Yes!'],
      ['Builder', null, ['always-solvable shuffles', 'undo stack', 'best time per size']],
    ],
    points: [
      ['Always solvable', 'Shuffles are generated from solved boards, so every puzzle has an answer.'],
      ['Clean UI', 'A HUD component for moves, time and best scores, kept separate from game logic.'],
      ['You confirm first', 'Nothing is built until you say yes to the design summary.'],
    ],
  },
};

function renderTemplate(key) {
  const t = TEMPLATES[key];
  const thread = $('tplThread');
  thread.replaceChildren();
  for (const [who, text, steps] of t.thread) {
    const li = el('li', who === 'You' ? 'msg msg-user' : steps ? 'msg steps' : 'msg');
    li.append(el('b', null, who));
    if (text) li.append(el('p', null, text));
    if (steps) {
      const ul = el('ul', 'mono');
      for (const s of steps) {
        const item = el('li');
        item.append(el('i', 'ok'), document.createTextNode(s));
        ul.append(item);
      }
      li.append(ul);
    }
    thread.append(li);
  }
  const points = $('tplPoints');
  points.replaceChildren();
  for (const [lead, body] of t.points) {
    const li = el('li');
    li.append(el('b', null, lead), el('span', null, body));
    points.append(li);
  }
  const cta = $('templateCta');
  cta.textContent = `Use the ${t.label} template`;
  cta.href = `/chat?prompt=${encodeURIComponent(t.prompt)}`;
  $('tpl-panel').setAttribute('aria-labelledby', `tab-${key}`);
}

const tabs = [...document.querySelectorAll('.tab[data-tpl]')];
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  renderTemplate(tab.dataset.tpl);
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    selectTab(next);
  });
}
selectTab(tabs[0]);

// ---------------------------------------------------------------- Project explorer
const FILES = [
  {
    path: 'frontend/index.html', badge: 'entry',
    note: 'The page that gets played. It loads the game as an ES module, with no bundler and no npm install.',
    code: '<canvas id="game"></canvas>\n<script type="module" src="./src/main.js"></script>',
  },
  {
    path: 'frontend/src/main.js', badge: 'generated',
    note: 'Wires input, the game loop and the HUD together.',
    code: "import { createGame } from './game/snake.js';\nimport { Hud } from './components/Hud.js';\nimport { startLoop } from './game/loop.js';\n\nconst game = createGame(document.getElementById('game'));\nconst hud = new Hud(game);\nstartLoop((dt) => { game.update(dt); hud.render(); });",
  },
  {
    path: 'frontend/src/game/loop.js', badge: 'generated',
    note: 'Gameplay logic lives under game/, the same folder every time.',
    code: 'export function startLoop(tick) {\n  let last = performance.now();\n  function frame(now) {\n    tick(Math.min((now - last) / 1000, 0.05));\n    last = now;\n    requestAnimationFrame(frame);\n  }\n  requestAnimationFrame(frame);\n}',
  },
  {
    path: 'frontend/src/components/Hud.js', badge: 'changed',
    note: 'Changed in v2 after “show my best score”. Only this file was rewritten.',
    code: "export class Hud {\n  constructor(game) { this.game = game; }\n  render() {\n    score.textContent = this.game.score;\n    best.textContent = localStorage.best ?? 0; // new in v2\n  }\n}",
  },
  {
    path: 'frontend/src/scenes/', badge: 'optional',
    note: 'Only created when the game has more than one screen.',
    code: 'TitleScene.js\nPlayScene.js\nGameOverScene.js',
  },
  {
    path: 'docs/GAME_DESIGN.md', badge: 'generated',
    note: 'Kept in sync with the design summary you confirmed.',
    code: '# Neon Snake\n\n- Genre: Arcade\n- Controls: arrow keys, swipe on touch\n- Walls wrap; 3 power-ups\n- Speed ramps every 5 apples',
  },
  {
    path: 'backend/', badge: 'optional',
    note: 'Only when the design truly needs a server, like a shared leaderboard. Yours to run; never executed by K Games.',
    code: 'src/server.js\nsrc/routes/leaderboard.js',
  },
];
const BADGE_CLASS = { entry: 'pill-accent', generated: '', changed: 'pill-gold', optional: 'pill-muted' };

const fileList = $('fileList');
function showFile(i) {
  const f = FILES[i];
  for (const [j, li] of [...fileList.children].entries()) li.setAttribute('aria-selected', String(j === i));
  $('filePath').textContent = f.path;
  const badge = $('fileBadge');
  badge.textContent = f.badge;
  badge.className = `pill ${BADGE_CLASS[f.badge]}`;
  $('fileNote').textContent = f.note;
  $('fileCode').textContent = f.code;
}
FILES.forEach((f, i) => {
  const li = el('li');
  li.setAttribute('role', 'option');
  li.tabIndex = 0;
  li.append(el('span', null, f.path), el('span', `pill ${BADGE_CLASS[f.badge]}`, f.badge));
  li.addEventListener('click', () => showFile(i));
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showFile(i); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (i + (e.key === 'ArrowDown' ? 1 : FILES.length - 1)) % FILES.length;
      fileList.children[next].focus();
      showFile(next);
    }
  });
  fileList.append(li);
});
showFile(1);
