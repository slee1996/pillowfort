let audioCtx: AudioContext | null = null;

export function ensureAudio(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function beep(freq: number, dur: number, delay = 0, vol = 0.1) {
  try {
    const ctx = ensureAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime + delay;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.start(t);
    osc.stop(t + dur);
  } catch {}
}

export function playDoorOpen() {
  beep(440, 0.1, 0, 0.08);
  beep(554, 0.1, 0.08, 0.08);
  beep(659, 0.18, 0.16, 0.08);
}

export function playDoorClose() {
  beep(659, 0.1, 0, 0.08);
  beep(554, 0.1, 0.08, 0.08);
  beep(440, 0.18, 0.16, 0.08);
}

export function playMsgSound() {
  beep(880, 0.06, 0, 0.06);
  beep(1109, 0.1, 0.05, 0.06);
}

export function playSendSound() {
  beep(660, 0.04, 0, 0.04);
}

export function playBreakoutHit() {
  beep(520, 0.05, 0, 0.04);
}

export function playBreakoutBrick() {
  beep(880, 0.03, 0, 0.03);
}

export { beep };
