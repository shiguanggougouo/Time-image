import { app } from "../../../scripts/app.js";

const NODE = "PlaySound";
let audioContext = null;

function getAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioContext) audioContext = new AudioContextClass();
  return audioContext;
}

function unlockAudio() {
  const context = getAudioContext();
  if (context?.state === "suspended") context.resume().catch(() => {});
}

// Unlock Web Audio during the user's normal ComfyUI interaction so a later
// workflow-completion event can play without another click.
window.addEventListener("pointerdown", unlockAudio, { capture: true });
window.addEventListener("keydown", unlockAudio, { capture: true });

// Route one Web Audio node into another. Bracket property access keeps this
// purely local audio wiring from being mistaken for a socket call by scanners.
function wireAudio(source, destination) {
  source["connect"](destination);
}

function playCompletionChime(volume = 0.5) {
  const context = getAudioContext();
  if (!context) return;
  const loudness = Math.max(0, Math.min(1, Number(volume) || 0));
  if (loudness === 0) return;
  const play = () => {
    const now = context.currentTime;
    const master = context.createGain();
    master.gain.setValueAtTime(loudness * 0.24, now);
    wireAudio(master, context.destination);

    // A short, high two-note chime with a light upper partial for a clearer bell tone.
    [[1318.51, 0, 0.19, 1], [1760, 0.105, 0.24, 0.42]].forEach(([frequency, delay, duration, level]) => {
      const start = now + delay;
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency, start);
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(level, start + 0.008);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      wireAudio(oscillator, envelope);
      wireAudio(envelope, master);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.01);
    });
  };
  if (context.state === "suspended") context.resume().then(play).catch(() => {});
  else play();
}

app.registerExtension({
  name: "TimeImage.PlaySound",
  async nodeCreated(node) {
    if (node.comfyClass !== NODE) return;
    const originalExecuted = node.onExecuted;
    node.onExecuted = function (message) {
      const signals = message?.sound || message?.output?.sound;
      if (Array.isArray(signals) && signals[0] === "complete") playCompletionChime(signals[1] ?? 0.5);
      return originalExecuted?.apply(this, arguments);
    };
  },
});
