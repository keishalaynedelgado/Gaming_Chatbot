'use strict';

// Turns the game code the Builder is actually writing into short, human-readable
// milestones for the chat's Planning feed. This only reacts to the model's visible
// OUTPUT (the code itself) -- it never touches its private reasoning, so the feed
// can never leak hidden chain-of-thought.
const MILESTONES = [
  { re: /addEventListener\(\s*['"]key(?:down|up)['"]/i, label: 'Wiring up the controls.' },
  { re: /addEventListener\(\s*['"]touch(?:start|end)['"]/i, label: 'Adding touch controls.' },
  { re: /requestAnimationFrame/i, label: 'Building the game loop.' },
  { re: /\b(?:vx|vy|velocity|dx|dy)\b/i, label: 'Designing the movement system.' },
  { re: /\benem(?:y|ies)\b/i, label: 'Preparing the enemy behavior.' },
  { re: /\bscore\b/i, label: 'Connecting the score system.' },
  { re: /AudioContext|new Audio\(/i, label: 'Adding sound effects.' },
  { re: /\brestart\b/i, label: 'Wiring up restart and game over.' },
  { re: /\bpaused?\b/i, label: 'Adding pause support.' },
];

// Returns a function you feed each text chunk to. It calls onMilestone(label) the
// first time each milestone's pattern shows up in the accumulated text, in the
// fixed priority order above, and never repeats one.
function milestoneScanner(onMilestone) {
  const seen = new Set();
  let text = '';
  return (delta) => {
    text += delta;
    for (const { re, label } of MILESTONES) {
      if (!seen.has(label) && re.test(text)) {
        seen.add(label);
        onMilestone(label);
      }
    }
  };
}

module.exports = { milestoneScanner };
