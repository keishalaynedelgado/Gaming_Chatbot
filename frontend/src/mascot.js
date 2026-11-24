'use strict';
// The floating K Games dragon mascot, drawn from the inline SVG poses in
// dragon.js. Every pose shares one canvas with the feet on the same baseline,
// so a pose swap never makes the dragon grow, shrink or jump.
//
// Motion is split in layers so nothing fights: CSS owns the always-on idle
// motion (bob + sway on .mascot-float, breathing via the `scale` property on
// .mascot-art, the ground shadow), the spring loop below leans .mascot-lean
// toward the cursor and adds a little hop, and a click plays a short Web
// Animations pose swap on .mascot-art's `transform`. The loop only runs while
// something is moving, and mascots removed from the DOM drop out.

import { POSES, dragonSvg, newDragonId } from './dragon.js';

const DEFAULT_POSE = 0; // front-facing, waving hello

const mascots = new Set();
const byEl = new WeakMap(); // mascot element -> its state, for setMascotStatus()
let pointer = null; // { x, y, at } in viewport px, or null when outside the window
let rafId = 0;
let lastFrame = 0;
const IDLE_MS = 3500; // cursor resting this long -> ease back to neutral
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const spring = (k, c) => ({ x: 0, v: 0, t: 0, k, c });
function stepSpring(s, dt) {
  s.v += (s.k * (s.t - s.x) - s.c * s.v) * dt;
  s.x += s.v * dt;
}
const settled = (s) => Math.abs(s.v) < 0.004 && Math.abs(s.t - s.x) < 0.004;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// placement: 'welcome' (centered above the welcome heading) or 'corner' (the
// small companion docked at the chat input's bottom-right once a conversation
// starts). Only the dragon itself takes clicks; its box never blocks the UI.
// tips: optional speech-bubble lines; each click on the dragon moves to the next.
// setMascotStatus() can temporarily replace the tip with a live status line.
export function createMascot({ placement = 'corner', tips = [] } = {}) {
  const el = document.createElement('div');
  el.className = `mascot mascot--${placement} is-ready`;
  el.innerHTML = `
    <div class="mascot-float"><div class="mascot-lean">
      <button type="button" class="mascot-hit" aria-label="The K Games dragon. Click to change pose.">
        <span class="mascot-art"></span>
      </button>
    </div></div>
    <div class="mascot-shadow" aria-hidden="true"></div>`;
  const bubble = document.createElement('div');
  bubble.className = 'mascot-bubble';
  bubble.textContent = tips[0] || '';
  el.prepend(bubble);

  const m = {
    el,
    lean: el.querySelector('.mascot-lean'),
    art: el.querySelector('.mascot-art'),
    id: newDragonId(), // keeps this dragon's gradient ids unique on the page
    pose: DEFAULT_POSE,
    swapping: false,
    body: spring(70, 9), // deg -- underdamped, so it eases in and overshoots a touch
    hop: spring(220, 11), // px
    // Where the dragon looks (-1..1 each way): drives the 3D head turn, via
    // --lx / --ly and the .d-* layer shifts in main.css.
    lookX: spring(90, 13),
    lookY: spring(90, 13),
    // Where the pupils point (-1..1): quicker than the head, so the eyes lead.
    eyeX: spring(260, 24),
    eyeY: spring(260, 24),
    engaged: false,
    bubble: el.querySelector('.mascot-bubble'),
    tips,
    tip: 0,
    status: '',
  };
  byEl.set(el, m);
  el.querySelector('.mascot-hit').addEventListener('click', () => changePose(m));
  showPose(m, m.pose);
  mascots.add(m);
  scheduleBlink(m);
  kick();
  return el;
}

function showPose(m, i) {
  m.pose = i;
  m.art.innerHTML = dragonSvg(i, { className: 'mascot-svg', id: m.id });
}

// Every 2.6-6.4s, sometimes a quick double blink. Skipped mid pose-swap.
function scheduleBlink(m) {
  setTimeout(() => {
    if (!m.el.isConnected) { mascots.delete(m); return; }
    blink(m);
    if (Math.random() < 0.2) setTimeout(() => blink(m), 280);
    scheduleBlink(m);
  }, 2600 + Math.random() * 3800);
}

function blink(m) {
  if (m.swapping || !POSES[m.pose].blinks) return;
  m.el.classList.add('is-blinking');
  setTimeout(() => m.el.classList.remove('is-blinking'), 140);
}

// ~300ms: squash down and fade a little, swap the pose at the bottom of the
// dip, then spring back up past full size and settle -- a soft bounce rather
// than an instant cut. Runs on .mascot-art's `transform`, so the float, lean
// and breathing layers keep going underneath it. The swap and the unlock run
// on timers rather than the animation's promise, so a throttled or cancelled
// animation can never leave the mascot stuck mid-swap.
const SWAP_MS = 300;
const SWAP_AT = 0.36; // the bottom of the dip, where the pose changes

function changePose(m) {
  if (m.swapping) return;
  const options = POSES.map((p, i) => i).filter((i) => i !== m.pose);
  const next = options[Math.floor(Math.random() * options.length)];
  m.swapping = true;
  m.el.classList.remove('is-blinking');

  if (reduceMotion.matches) {
    m.art.animate([{ opacity: 1 }, { opacity: 0.2, offset: SWAP_AT }, { opacity: 1 }], { duration: 240 });
  } else {
    m.hop.v -= 90; // a little jump as it changes
    kick();
    m.art.animate(
      [
        { transform: 'scale(1)', opacity: 1, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
        { transform: 'scale(0.84, 0.8)', opacity: 0.55, offset: SWAP_AT, easing: 'ease-out' },
        { transform: 'scale(1.07, 1.1)', opacity: 1, offset: 0.72, easing: 'ease-in-out' },
        { transform: 'scale(1)', opacity: 1 },
      ],
      { duration: SWAP_MS },
    );
  }
  setTimeout(() => {
    showPose(m, next);
    if (m.tips.length) {
      m.tip = (m.tip + 1) % m.tips.length;
      if (!m.status) setBubble(m, m.tips[m.tip]); // a live status keeps the bubble until it clears
    }
  }, SWAP_MS * SWAP_AT);
  setTimeout(() => { m.swapping = false; }, SWAP_MS);
}

function setBubble(m, text) {
  if (m.bubble.textContent === text) return;
  m.bubble.textContent = text;
  m.bubble.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
}

// Shows a live status (e.g. "Understanding your request…") in the mascot's
// speech bubble with a pulsing dot; an empty string goes back to the tips.
export function setMascotStatus(el, text) {
  const m = byEl.get(el);
  if (!m) return;
  m.status = text || '';
  m.bubble.classList.toggle('is-busy', !!m.status);
  setBubble(m, m.status || m.tips[m.tip] || '');
}

function updateTargets(m, now) {
  const r = m.el.getBoundingClientRect();
  // Eyes: look at the cursor whenever it's in the window (not just while it
  // moves). Measured from the eyes (a third of the way down the art); the
  // direction is near-unit far away and shrinks as the cursor nears the face.
  const art = m.art.getBoundingClientRect();
  if (pointer && art.width > 0 && !reduceMotion.matches) {
    const ex = pointer.x - (art.left + art.width / 2);
    const ey = pointer.y - (art.top + art.height * 0.33);
    const d = Math.hypot(ex, ey) + 50;
    m.eyeX.t = ex / d;
    m.eyeY.t = ey / d;
  } else {
    m.eyeX.t = 0;
    m.eyeY.t = 0;
  }
  const active = pointer && now - pointer.at < IDLE_MS && r.width > 0;
  if (m.engaged && !active && !reduceMotion.matches) m.hop.v -= 70; // pop up a little as it lets go
  m.engaged = !!active;
  if (!active || reduceMotion.matches) { m.body.t = 0; m.lookX.t = 0; m.lookY.t = 0; return; }
  const dx = pointer.x - (r.left + r.width / 2);
  const dy = pointer.y - (r.top + r.height * 0.4); // roughly eye level
  m.body.t = clamp(dx / 380, -1, 1) * 11;
  m.lookX.t = clamp(dx / 320, -1, 1);
  m.lookY.t = clamp(dy / 320, -1, 1);
}

function frame(now) {
  const dt = Math.min(0.033, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;
  let moving = false;
  for (const m of mascots) {
    if (!m.el.isConnected) { mascots.delete(m); continue; }
    updateTargets(m, now);
    for (const s of [m.body, m.hop, m.lookX, m.lookY, m.eyeX, m.eyeY]) {
      stepSpring(s, dt / 2); stepSpring(s, dt / 2); // two substeps keep the stiff springs stable
      if (!settled(s)) moving = true;
    }
    if (m.engaged) moving = true; // keep watching until the cursor goes idle
    m.lean.style.transform = `translateY(${m.hop.x.toFixed(2)}px) rotate(${m.body.x.toFixed(2)}deg)`;
    m.el.style.setProperty('--lx', m.lookX.x.toFixed(3));
    m.el.style.setProperty('--ly', m.lookY.x.toFixed(3));
    m.el.style.setProperty('--ex', m.eyeX.x.toFixed(3));
    m.el.style.setProperty('--ey', m.eyeY.x.toFixed(3));
  }
  rafId = moving ? requestAnimationFrame(frame) : 0;
}

function kick() {
  if (rafId) return;
  lastFrame = performance.now();
  rafId = requestAnimationFrame(frame);
}

window.addEventListener('pointermove', (e) => {
  pointer = { x: e.clientX, y: e.clientY, at: performance.now() };
  kick();
}, { passive: true });
document.documentElement.addEventListener('mouseleave', () => { pointer = null; kick(); });
window.addEventListener('blur', () => { pointer = null; kick(); });
