// Small WebAudio kit: wind that rises with speed, tyre roll that changes with
// the surface, and one-shots for hops, landings, crashes and boost. Nothing is
// loaded from disk — every sound is synthesised, so the game has no assets.
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let windGain: GainNode | null = null;
let windFilter: BiquadFilterNode | null = null;
let rollGain: GainNode | null = null;
let rollFilter: BiquadFilterNode | null = null;
let started = false;
let muted = false;

function noiseBuffer(c: AudioContext, seconds = 2): AudioBuffer {
  const buf = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

export function initAudio() {
  if (started) return;
  started = true;
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);

    const wind = ctx.createBufferSource();
    wind.buffer = noiseBuffer(ctx);
    wind.loop = true;
    windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 500;
    windFilter.Q.value = 0.7;
    windGain = ctx.createGain();
    windGain.gain.value = 0;
    wind.connect(windFilter).connect(windGain).connect(master);
    wind.start();

    const roll = ctx.createBufferSource();
    roll.buffer = noiseBuffer(ctx);
    roll.loop = true;
    rollFilter = ctx.createBiquadFilter();
    rollFilter.type = 'lowpass';
    rollFilter.frequency.value = 700;
    rollGain = ctx.createGain();
    rollGain.gain.value = 0;
    roll.connect(rollFilter).connect(rollGain).connect(master);
    roll.start();
  } catch {
    ctx = null;
  }
}

export function resumeAudio() {
  if (ctx?.state === 'suspended') void ctx.resume();
}
export function setMuted(m: boolean) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.5;
}
export const isMuted = () => muted;

// Called every frame with the local rider's state.
export function updateRide(speed: number, airborne: boolean, slip: number, grip: number) {
  if (!ctx || !windGain || !rollGain || !windFilter || !rollFilter) return;
  const v = Math.max(0, speed);
  const k = Math.min(1, v / 45);
  windGain.gain.value = 0.02 + k * k * 0.28;
  windFilter.frequency.value = 380 + k * 900;
  rollGain.gain.value = airborne ? 0 : 0.04 + k * 0.18 + slip * 0.25;
  rollFilter.frequency.value = 380 + k * 1400 * grip + slip * 900;
}

function blip(freq: number, dur: number, type: OscillatorType, gain = 0.25, sweep = 0) {
  if (!ctx || !master || muted) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, ctx.currentTime);
  if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), ctx.currentTime + dur);
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  o.connect(g).connect(master);
  o.start();
  o.stop(ctx.currentTime + dur);
}

function burst(dur: number, freq: number, gain = 0.4) {
  if (!ctx || !master || muted) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.5);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(freq, ctx.currentTime);
  f.frequency.exponentialRampToValueAtTime(120, ctx.currentTime + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  src.connect(f).connect(g).connect(master);
  src.start();
  src.stop(ctx.currentTime + dur);
}

export const playHop = () => blip(220, 0.12, 'square', 0.12, 260);
export const playLand = (perfect: boolean) => {
  burst(perfect ? 0.18 : 0.3, perfect ? 1600 : 700, perfect ? 0.3 : 0.45);
  if (perfect) blip(880, 0.1, 'triangle', 0.14, 420);
};
export const playCrash = () => {
  burst(0.55, 2200, 0.6);
  blip(90, 0.35, 'sawtooth', 0.25, -50);
};
export const playBoost = () => blip(320, 0.35, 'sawtooth', 0.18, 620);
export const playTrick = () => {
  blip(520, 0.1, 'triangle', 0.16, 300);
  setTimeout(() => blip(760, 0.14, 'triangle', 0.14, 400), 90);
};
export const playBeep = (last: boolean) => blip(last ? 880 : 440, last ? 0.35 : 0.14, 'square', 0.2);
export const playFinish = () => {
  [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => blip(f, 0.28, 'triangle', 0.22), i * 110));
};
