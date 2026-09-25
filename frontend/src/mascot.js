'use strict';
// Vi, the floating owl mascot, drawn from the pose set in assets/vi/.
//
// The pose images don't need to share a canvas: each file is measured once
// (the bounding box of its opaque pixels) and every bird is then drawn at the
// same pixel scale, horizontally centered, feet on one shared baseline, inside
// one common stage sized to fit the largest pose. So a pose with more or less
// empty padding around the bird never makes Vi grow, shrink or jump.
//
// Motion is split in layers so nothing fights: CSS owns the always-on idle
// motion (bob + sway on .mascot-float, breathing via the `scale` property on
// .mascot-art, the ground shadow), the spring loop below leans .mascot-lean
// toward the cursor and adds a little hop, and a click plays a short Web
// Animations pose swap on .mascot-art's `transform`. The loop only runs while
// something is moving, and mascots removed from the DOM drop out.

const POSE_URLS = Array.from({ length: 9 }, (_, i) => new URL(`./assets/vi/pose-${i + 1}.png`, import.meta.url).href);
const DEFAULT_POSE = 0; // front-facing
const STAGE_PAD = 4; // source px of headroom kept around the largest pose
// The front pose's bird fills this share of the stage's height, whatever the
// pose set -- so Vi stays the same on-screen size even when a set has wide
// props (a racing wheel, spread wings) that would otherwise shrink the stage.
const DEFAULT_BIRD_HEIGHT_SHARE = 0.917;
const STAGE_ASPECT = 420 / 412; // width / height

// Eyes per pose: [x0, y0, x1, y1] around each iris, in source pixels measured
// from the top-left of the bird itself (not the image edge, so re-cropped or
// re-padded images still line up), plus the face color around them. Eyelids
// in that color close over the eyes to blink; the back views have no eyes.
// Gamer set: controller, headset, handheld, Game Boy, joystick, racing wheel
// (back view), VR headset, arcade stick, chips. No blink where no eyes show:
// the back view, the VR headset and the eyes-shut chips pose.
const EYES = [
  { lid: 'rgb(137,160,193)', eyes: [[34, 44, 41, 55], [61, 42, 68, 55]] },
  { lid: 'rgb(131,157,191)', eyes: [[46, 44, 55, 56]] },
  { lid: 'rgb(139,164,197)', eyes: [[45, 46, 51, 56], [66, 44, 75, 57]] },
  { lid: 'rgb(132,157,194)', eyes: [[26, 40, 33, 50], [52, 39, 59, 50]] },
  { lid: 'rgb(131,157,194)', eyes: [[41, 39, 48, 50]] },
  { lid: null, eyes: [] },
  { lid: null, eyes: [] },
  { lid: 'rgb(152,174,205)', eyes: [[43, 41, 50, 49]] },
  { lid: null, eyes: [] },
];
const LID_PAD = 2; // px beyond the iris, so the lid also covers the white of the eye

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
const pct = (n, of) => `${((n / of) * 100).toFixed(3)}%`;

// ---- Pose measuring (once, shared by every mascot) ----
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(`could not load ${src}`));
    im.src = src;
  });
}

// Bounding box of the bird's opaque pixels, plus a cheap content signature so
// two files holding the same picture count as one pose (a click then always
// shows a visibly different pose). If pixels can't be read, the whole image is
// treated as the bird -- still drawn, just without the padding correction.
function measure(im, src) {
  const w = im.naturalWidth;
  const h = im.naturalHeight;
  try {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, sig = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = d[(y * w + x) * 4 + 3];
        if (a <= 24) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) throw new Error('empty image');
    for (let i = 0; i < d.length; i += 4 * 97) sig = (sig * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3]) >>> 0;
    return { src, w, h, bx: x0, by: y0, bw: x1 - x0 + 1, bh: y1 - y0 + 1, sig: `${w}x${h}:${sig}` };
  } catch {
    return { src, w, h, bx: 0, by: 0, bw: w, bh: h, sig: src };
  }
}

// Resolves to { stageW, stageH, poses: [{ src, img: {left, top, width}, eyes, sig }] }
// with every position already expressed as a percentage of the shared stage.
const posesReady = Promise.all(POSE_URLS.map((src) => loadImage(src).then((im) => measure(im, src))))
  .then((list) => {
    // Sized from the front pose, then grown only if some pose wouldn't fit.
    const refH = list[DEFAULT_POSE].bh / DEFAULT_BIRD_HEIGHT_SHARE;
    const stageH = Math.max(refH, Math.max(...list.map((p) => p.bh)) + STAGE_PAD * 2);
    const stageW = Math.max(refH * STAGE_ASPECT, Math.max(...list.map((p) => p.bw)) + STAGE_PAD * 2);
    const poses = list.map((p, i) => {
      const birdLeft = (stageW - p.bw) / 2; // centered
      const birdTop = stageH - STAGE_PAD - p.bh; // feet on the shared baseline
      return {
        src: p.src,
        sig: p.sig,
        img: { left: pct(birdLeft - p.bx, stageW), top: pct(birdTop - p.by, stageH), width: pct(p.w, stageW) },
        lid: EYES[i]?.lid,
        eyes: (EYES[i]?.eyes || []).map(([x0, y0, x1, y1]) => ({
          left: pct(birdLeft + x0 - LID_PAD, stageW),
          top: pct(birdTop + y0 - LID_PAD, stageH),
          width: pct(x1 - x0 + LID_PAD * 2, stageW),
          height: pct(y1 - y0 + LID_PAD * 2, stageH),
        })),
      };
    });
    return { stageW, stageH, poses };
  });

// placement: 'welcome' (centered above the welcome heading) or 'corner' (the
// small companion docked at the chat input's bottom-right once a conversation
// starts). Only the owl itself takes clicks; its box never blocks the UI.
// tips: optional speech-bubble lines; each click on the owl moves to the next.
// setMascotStatus() can temporarily replace the tip with a live status line.
export function createMascot({ placement = 'corner', tips = [] } = {}) {
  const el = document.createElement('div');
  el.className = `mascot mascot--${placement}`;
  el.innerHTML = `
    <div class="mascot-float"><div class="mascot-lean">
      <button type="button" class="mascot-hit" aria-label="Vi, the Ask Vi Games owl. Click to change pose.">
        <span class="mascot-art">
          <img class="mascot-img" alt="" draggable="false">
          <span class="mascot-lids" aria-hidden="true"></span>
        </span>
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
    img: el.querySelector('.mascot-img'),
    lids: el.querySelector('.mascot-lids'),
    pose: DEFAULT_POSE,
    layout: null, // filled in once the pose images are measured
    swapping: false,
    body: spring(70, 9), // deg -- underdamped, so it eases in and overshoots a touch
    hop: spring(220, 11), // px
    engaged: false,
    bubble: el.querySelector('.mascot-bubble'),
    tips,
    tip: 0,
    status: '',
  };
  byEl.set(el, m);
  el.querySelector('.mascot-hit').addEventListener('click', () => changePose(m));
  // The stage keeps a sensible shape while the poses are being measured, then
  // takes the measured one; the bird fades in once it can be placed properly.
  posesReady.then((layout) => {
    m.layout = layout;
    m.art.style.aspectRatio = `${layout.stageW} / ${layout.stageH}`;
    showPose(m, m.pose);
    el.classList.add('is-ready');
  });
  mascots.add(m);
  scheduleBlink(m);
  kick();
  return el;
}

// Puts pose i on the stage: the image positioned so its bird lands centered
// on the shared baseline, and eyelids over that pose's eyes.
function showPose(m, i) {
  const p = m.layout.poses[i];
  m.pose = i;
  m.img.src = p.src;
  Object.assign(m.img.style, p.img);
  m.lids.innerHTML = '';
  for (const e of p.eyes) {
    const l = document.createElement('span');
    l.className = 'mascot-lid';
    Object.assign(l.style, e);
    l.style.setProperty('--lid', p.lid);
    m.lids.appendChild(l);
  }
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
  if (m.swapping || !m.layout?.poses[m.pose].eyes.length) return;
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
const SWAP_AT = 0.36; // the bottom of the dip, where the image changes

function changePose(m) {
  if (m.swapping || !m.layout) return;
  // Any pose that looks different from the current one (files holding the
  // same picture share a signature, so they never count as a change).
  const { poses } = m.layout;
  const current = poses[m.pose].sig;
  const options = poses.map((p, i) => i).filter((i) => poses[i].sig !== current);
  if (!options.length) return;
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
  const active = pointer && now - pointer.at < IDLE_MS && r.width > 0;
  if (m.engaged && !active && !reduceMotion.matches) m.hop.v -= 70; // pop up a little as it lets go
  m.engaged = !!active;
  if (!active || reduceMotion.matches) { m.body.t = 0; return; }
  const dx = pointer.x - (r.left + r.width / 2);
  m.body.t = clamp(dx / 380, -1, 1) * 11;
}

function frame(now) {
  const dt = Math.min(0.033, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;
  let moving = false;
  for (const m of mascots) {
    if (!m.el.isConnected) { mascots.delete(m); continue; }
    updateTargets(m, now);
    for (const s of [m.body, m.hop]) {
      stepSpring(s, dt / 2); stepSpring(s, dt / 2); // two substeps keep the stiff springs stable
      if (!settled(s)) moving = true;
    }
    if (m.engaged) moving = true; // keep watching until the cursor goes idle
    m.lean.style.transform = `translateY(${m.hop.x.toFixed(2)}px) rotate(${m.body.x.toFixed(2)}deg)`;
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
