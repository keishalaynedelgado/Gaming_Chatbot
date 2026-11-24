'use strict';
// The K Games dragon, drawn as inline SVG with 3D-style shading: every round
// part is lit from the top-left (a bright highlight, a darker rim, an
// ambient-occlusion edge and a soft specular shine), and parts in front cast
// soft shadows on parts behind.
//
// It is also split into depth layers (back: wings and tail; body; horns;
// head; face; front: arms and props). mascot.js sets --lx / --ly (-1..1)
// from the cursor and main.css shifts each layer by a different amount, so
// the head seems to turn toward the cursor in 3D.
//
// Every pose shares one 200x200 canvas with the feet on the same baseline.
// No DOM access here: mascot.js puts the markup on the page, and the same
// markup is saved as assets/dragon/dragon.svg (favicon, sidebar logo, dialog
// icon). Gradient and filter ids carry a per-mascot prefix, so several
// dragons on one page never borrow each other's.

const OL = '#0b3a35'; // outline
const C = {
  limb: '#1fa592',
  limbShine: '#9ff7e8',
  bellyLine: '#d9b061',
  snoutLine: '#c49a4e',
  nostril: '#a5782f',
  bone: '#b8650c',
  mouth: '#3a1220',
  tongue: '#ff7f8f',
  claw: '#fff4d2',
  gold: '#ffd24a',
};

const mirror = (inner) => `<g transform="matrix(-1 0 0 1 200 0)">${inner}</g>`;
const line = (d, color, w, extra = '') => `<path d="${d}" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"${extra}/>`;

function defs(p) {
  const stops = (list) => list.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('');
  return `<defs>
<radialGradient id="${p}body" cx="40%" cy="34%" r="72%" fx="32%" fy="24%">${stops([[0, '#d2fff6'], [0.16, '#78ecd8'], [0.5, '#27baa4'], [0.82, '#14897b'], [1, '#0b5c53']])}</radialGradient>
<radialGradient id="${p}ao" cx="50%" cy="46%" r="54%">${stops([[0.62, '#052b28', 0], [1, '#052b28', 0.5]])}</radialGradient>
<radialGradient id="${p}belly" cx="42%" cy="28%" r="78%">${stops([[0, '#fffef6'], [0.5, '#fbe6ae'], [1, '#d4aa5e']])}</radialGradient>
<radialGradient id="${p}snout" cx="44%" cy="28%" r="80%">${stops([[0, '#fffef6'], [0.55, '#f8e1a4'], [1, '#cfa358']])}</radialGradient>
<linearGradient id="${p}wing" x1="1" y1="0.35" x2="0" y2="0.75">${stops([[0, '#c86a0a'], [0.35, '#f3a61b'], [0.75, '#ffd44f'], [1, '#fff1a8']])}</linearGradient>
<linearGradient id="${p}spike" x1="0" y1="0" x2="1" y2="1">${stops([[0, '#fff1a8'], [0.5, '#fbbf24'], [1, '#d07612']])}</linearGradient>
<linearGradient id="${p}horn" x1="0" y1="0" x2="1" y2="0.2">${stops([[0, '#a77d36'], [0.38, '#fff7dc'], [0.62, '#efd393'], [1, '#97702c']])}</linearGradient>
<radialGradient id="${p}eye" cx="50%" cy="40%" r="70%">${stops([[0, '#13292c'], [1, '#050a0c']])}</radialGradient>
<radialGradient id="${p}iris" cx="50%" cy="66%" r="62%">${stops([[0, '#8ffbea'], [0.42, '#26c2ae'], [0.82, '#0f5f59'], [1, '#0a2e2d']])}</radialGradient>
<radialGradient id="${p}ball" cx="38%" cy="30%" r="75%">${stops([[0, '#8ff5e2'], [0.45, '#22ac98'], [1, '#0b5e55']])}</radialGradient>
<radialGradient id="${p}cheek" cx="50%" cy="50%" r="50%">${stops([[0, '#ff7f9a', 0.9], [1, '#ff7f9a', 0]])}</radialGradient>
<linearGradient id="${p}pad" x1="0" y1="0" x2="0" y2="1">${stops([[0, '#625d82'], [0.5, '#37334a'], [1, '#1d1a27']])}</linearGradient>
<radialGradient id="${p}fire" cx="20%" cy="50%" r="90%">${stops([[0, '#fff6c2'], [0.35, '#ffd24a'], [0.7, '#ff8a2f'], [1, '#e8452a']])}</radialGradient>
<filter id="${p}soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2"/></filter>
<filter id="${p}shade" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
</defs>`;
}

function parts(p) {
  const g = (id) => `url(#${p}${id})`;
  const shine = (cx, cy, rx, ry, rot, op = 0.6) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff" opacity="${op}" transform="rotate(${rot} ${cx} ${cy})" filter="${g('soft')}"/>`;
  // A rounded limb: outline, body color, and a thin highlight along its top.
  const tube = (d, w) => line(d, OL, w + 5) + line(d, C.limb, w) + line(d, C.limbShine, Math.max(1.5, w / 4), ` opacity="0.55" transform="translate(-0.8 -1.6)"`);
  const ball = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${g('ball')}" stroke="${OL}" stroke-width="2.5"/><circle cx="${cx - r * 0.35}" cy="${cy - r * 0.4}" r="${r * 0.28}" fill="#fff" opacity="0.6"/>`;

  // ---- back layer: wings and tail
  const wing = `<path d="M74 116 C60 92 36 78 12 82 Q30 96 16 114 Q38 118 34 138 Q52 128 66 140 Z" fill="${g('wing')}" stroke="${OL}" stroke-width="3" stroke-linejoin="round"/>`
    + line('M72 113 Q42 102 16 114 M71 118 Q50 124 34 138', C.bone, 2.5)
    + line('M74 116 C60 92 36 78 12 82', OL, 5)
    + line('M72 113 C59 92 37 81 16 83', '#ffe9a6', 1.4, ' opacity="0.7"');
  const tail = tube('M122 166 C146 184 176 182 182 158', 12)
    + `<path d="M150 173 l6 -10 4 10 Z M169 168 l4 -10 6 7 Z" fill="${g('spike')}" stroke="${OL}" stroke-width="2" stroke-linejoin="round"/>`
    + `<path d="M186 128 C192 134 198 144 196 156 C191 152 187 152 184 157 C180 152 176 151 171 154 C171 144 177 135 186 128 Z" fill="${g('spike')}" stroke="${OL}" stroke-width="3" stroke-linejoin="round"/>`
    + line('M184 134 C180 140 177 145 176 150', '#fff6c2', 1.5, ' opacity="0.75"');
  const back = tail + mirror(wing) + wing;

  // ---- body layer: body, belly, feet, and the head's shadow on the body
  const foot = `<ellipse cx="80" cy="184" rx="17" ry="10" fill="${g('ball')}" stroke="${OL}" stroke-width="3"/>`
    + `<ellipse cx="75" cy="180" rx="6" ry="2.5" fill="#fff" opacity="0.4"/>`
    + [69, 78, 87].map((x, i) => `<circle cx="${x}" cy="${[189, 191.5, 190.5][i]}" r="3" fill="${C.claw}" stroke="${OL}" stroke-width="1.5"/>`).join('');
  const body = `<ellipse cx="100" cy="140" rx="40" ry="44" fill="${g('body')}" stroke="${OL}" stroke-width="3"/>`
    + `<ellipse cx="100" cy="140" rx="38.5" ry="42.5" fill="${g('ao')}"/>`
    + `<ellipse cx="100" cy="148" rx="25" ry="31" fill="${g('belly')}"/>`
    + line('M80 132 Q100 139 120 132 M77 146 Q100 153 123 146 M80 160 Q100 167 120 160 M86 172 Q100 177 114 172', C.bellyLine, 2.4)
    + line('M82 131 Q100 137 118 131 M79 145 Q100 151 121 145 M82 159 Q100 165 118 159', '#fffbe8', 1.2, ' opacity="0.7"')
    + shine(77, 118, 9, 4.5, -35, 0.55)
    + line('M131 116 A40 44 0 0 1 137 152', '#a8fff0', 2, ' opacity="0.45"')
    + `<ellipse cx="100" cy="107" rx="35" ry="8" fill="#032a26" opacity="0.5" filter="${g('shade')}"/>`;
  const bodyLayer = body + mirror(foot) + foot;

  // ---- horns layer: horns, ear frills and head spikes (behind the head)
  const horn = `<path d="M74 44 C64 32 60 18 68 6 C74 20 84 30 92 38 Z" fill="${g('horn')}" stroke="${OL}" stroke-width="3" stroke-linejoin="round"/>`
    + line('M70 26 l6 -2 M73 34 l6 -2', '#b8954c', 2);
  const frill = `<path d="M58 62 L34 48 L42 66 L30 78 L58 80 Z" fill="${g('wing')}" stroke="${OL}" stroke-width="3" stroke-linejoin="round"/>`
    + line('M56 66 L42 66', C.bone, 2);
  const horns = mirror(horn) + horn + mirror(frill) + frill
    + `<path d="M86 37 L93 18 L100 32 L107 18 L114 37 Z" fill="${g('spike')}" stroke="${OL}" stroke-width="3" stroke-linejoin="round"/>`;

  // ---- head layer: the round head itself
  const head = `<ellipse cx="100" cy="70" rx="47" ry="39" fill="${g('body')}" stroke="${OL}" stroke-width="3"/>`
    + `<ellipse cx="100" cy="70" rx="45.5" ry="37.5" fill="${g('ao')}"/>`
    + shine(80, 46, 17, 7, -18, 0.65)
    + `<circle cx="74" cy="44" r="2.2" fill="#fff" opacity="0.9"/>`
    + [[100, 42, 3], [91, 46, 2], [109, 46, 2]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#c4fff4" opacity="0.75"/>`).join('')
    + line('M139 52 A47 39 0 0 1 146 80', '#a8fff0', 2, ' opacity="0.45"');

  // ---- face layer: snout, cheeks, eyes, mouth (moves the most)
  const face = `<ellipse cx="63" cy="86" rx="9" ry="5.5" fill="${g('cheek')}"/><ellipse cx="137" cy="86" rx="9" ry="5.5" fill="${g('cheek')}"/>`
    + `<ellipse cx="100" cy="89" rx="25" ry="15.5" fill="${g('snout')}" stroke="${C.snoutLine}" stroke-width="1.5"/>`
    + shine(92, 82, 9, 3.2, -8, 0.75)
    + line('M90 84 q2.5 -2.5 5 0 M105 84 q2.5 -2.5 5 0', C.nostril, 2);

  const smile = line('M90 95 Q100 103 110 95', OL, 2.6)
    + `<path d="M103.5 98.6 L107.5 97.6 L105.6 102.4 Z" fill="#fff" stroke="${OL}" stroke-width="1" stroke-linejoin="round"/>`;
  const openMouth = `<path d="M89 94 Q100 110 111 94 Q100 98 89 94 Z" fill="${C.mouth}" stroke="${OL}" stroke-width="2.5" stroke-linejoin="round"/>`
    + `<ellipse cx="100" cy="102" rx="5" ry="2.6" fill="${C.tongue}"/>`;

  // A glossy eye: a dark socket holding a glowing teal iris and pupil. The
  // iris group (.d-pupil) slides toward the cursor (mascot.js --ex / --ey,
  // main.css), clipped to the eye; the shines stay put like a real
  // reflection. It carries its own eyelid (scaled to 0 until the mascot
  // blinks -- see .dragon-lid in main.css).
  const eyeOpen = (cx) => `<clipPath id="${p}ec${cx}"><ellipse cx="${cx}" cy="66" rx="9.5" ry="11.5"/></clipPath>`
    + `<ellipse cx="${cx}" cy="66" rx="9.5" ry="11.5" fill="${g('eye')}"/>`
    + `<g clip-path="url(#${p}ec${cx})"><g class="d-pupil">`
    + `<circle cx="${cx}" cy="67" r="7.4" fill="${g('iris')}"/>`
    + `<ellipse cx="${cx}" cy="67" rx="3.5" ry="4.4" fill="#03090a"/>`
    + '</g></g>'
    + `<ellipse cx="${cx}" cy="66" rx="9.5" ry="11.5" fill="none" stroke="${OL}" stroke-width="2"/>`
    + `<circle cx="${cx + 3.5}" cy="61.5" r="3.6" fill="#fff"/><circle cx="${cx - 3}" cy="71" r="1.5" fill="#fff" opacity="0.85"/>`
    + `<ellipse class="dragon-lid" cx="${cx}" cy="66" rx="11" ry="13" fill="${g('body')}" stroke="${OL}" stroke-width="2"/>`;
  const eyeHappy = (cx) => line(`M${cx - 9} 69 Q${cx} 57 ${cx + 9} 69`, OL, 3.4);

  // ---- front layer: arms and props
  const arm = (d, hx, hy) => tube(d, 8) + ball(hx, hy, 7.5);
  const armDownL = arm('M68 124 Q58 138 62 152', 62, 153);
  const armDownR = arm('M132 124 Q142 138 138 152', 138, 153);
  const armUpL = arm('M68 124 Q50 112 52 92', 52, 90);
  const armUpR = arm('M132 124 Q150 112 148 92', 148, 90);

  const gamepad = tube('M68 124 Q62 144 72 155', 8) + tube('M132 124 Q138 144 128 155', 8)
    + `<ellipse cx="100" cy="166" rx="30" ry="4" fill="#032a26" opacity="0.45" filter="${g('soft')}"/>`
    + `<rect x="66" y="137" width="68" height="27" rx="13.5" fill="${g('pad')}" stroke="${OL}" stroke-width="2.5"/>`
    + line('M76 141 h48', '#fff', 1.5, ' opacity="0.25"')
    + line('M83 150 h12 M89 144 v12', '#14121c', 4.4) + line('M83 150 h12 M89 144 v12', '#e6e3ef', 3)
    + [[106, 148, 3.4, '#ff8a8a'], [113, 154, 3.4, '#2dd4bf'], [114, 146, 2.4, C.gold]]
      .map(([x, y, r, c]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" stroke="#14121c" stroke-width="0.8"/><circle cx="${x - r * 0.3}" cy="${y - r * 0.35}" r="${r * 0.35}" fill="#fff" opacity="0.7"/>`).join('')
    + ball(72, 156, 7.5) + ball(128, 156, 7.5);

  const flame = `<path d="M114 96 C126 82 140 92 150 78 C150 90 162 92 174 82 C172 104 148 116 126 108 C118 106 114 102 114 96 Z" fill="${g('fire')}"/>`
    + `<path d="M120 98 C130 92 140 96 148 90 C149 98 157 100 164 96 C158 106 140 110 128 104 Z" fill="#fff6c2" opacity="0.8"/>`
    + `<circle cx="178" cy="74" r="3" fill="${C.gold}" opacity="0.85"/><circle cx="168" cy="66" r="2" fill="#ff8a2f" opacity="0.75"/>`;

  const sparkle = (x, y, s) => `<path d="M${x} ${y - 10 * s} L${x + 3 * s} ${y - 3 * s} L${x + 10 * s} ${y} L${x + 3 * s} ${y + 3 * s} L${x} ${y + 10 * s} L${x - 3 * s} ${y + 3 * s} L${x - 10 * s} ${y} L${x - 3 * s} ${y - 3 * s} Z" fill="${C.gold}" stroke="${OL}" stroke-width="1.5" stroke-linejoin="round"/>`;
  const sparkles = sparkle(28, 56, 1) + sparkle(172, 44, 0.75) + sparkle(178, 104, 0.5);

  return {
    back, bodyLayer, horns, head, face,
    smile, openMouth, eyeOpen, eyeHappy, armDownL, armDownR, armUpL, armUpR, gamepad, flame, sparkles,
  };
}

// Each pose: what goes on the face (eyes, mouth, flame), what goes in front
// (arms, props) and any effect on top. `blinks` is false where no open eye shows.
const POSE_DEFS = [
  { name: 'hello', blinks: true, face: (k) => k.eyeOpen(79) + k.eyeOpen(121) + k.smile, front: (k) => k.armDownL + k.armDownR },
  { name: 'wave', blinks: true, face: (k) => k.eyeOpen(79) + k.eyeOpen(121) + k.smile, front: (k) => k.armDownL + k.armUpR },
  { name: 'gamer', blinks: true, face: (k) => k.eyeOpen(79) + k.eyeOpen(121) + k.smile, front: (k) => k.gamepad },
  { name: 'fire', blinks: false, face: (k) => k.eyeHappy(79) + k.eyeHappy(121) + k.openMouth + k.flame, front: (k) => k.armDownL + k.armDownR },
  { name: 'cheer', blinks: true, face: (k) => k.eyeHappy(79) + k.eyeOpen(121) + k.openMouth, front: (k) => k.armUpL + k.armUpR, extra: (k) => k.sparkles },
];
export const POSES = POSE_DEFS.map(({ name, blinks }) => ({ name, blinks }));

let instances = 0;
export const newDragonId = () => `kgd${(instances += 1)}-`;

export function dragonSvg(i = 0, { className = '', standalone = false, id = 'kgd-' } = {}) {
  const pose = POSE_DEFS[i] || POSE_DEFS[0];
  const k = parts(id);
  const ns = standalone ? ' xmlns="http://www.w3.org/2000/svg"' : '';
  const cls = className ? ` class="${className}"` : '';
  const svg = `<svg${ns}${cls} viewBox="0 0 200 200" aria-hidden="true">${defs(id)}`
    + `<g class="d-back">${k.back}</g>`
    + `<g class="d-body">${k.bodyLayer}</g>`
    + `<g class="d-horns">${k.horns}</g>`
    + `<g class="d-head">${k.head}</g>`
    + `<g class="d-face">${k.face}${pose.face(k)}</g>`
    + `<g class="d-front">${pose.front(k)}</g>`
    + (pose.extra ? `<g class="d-fx">${pose.extra(k)}</g>` : '')
    + '</svg>';
  // A standalone file has no stylesheet to keep the eyelids open, so it drops them.
  return standalone ? svg.replace(/<ellipse class="dragon-lid"[^>]*\/>/g, '') : svg;
}
