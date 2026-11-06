// Rilevamento dei battiti a partire dallo spettro di un AnalyserNode.
//
// Metodo: lo spettro viene diviso in bande logaritmiche (40 Hz - 8 kHz). A ogni
// fotogramma si misura quanto è cresciuta l'energia di ogni banda rispetto a
// ~30 ms prima ("spectral flux", in dB). Un battito è un picco di crescita che
// supera tre soglie: media + k · deviazione standard dell'ultimo secondo e
// mezzo, un multiplo della media (ignora il rumore costante) e una crescita
// minima (ignora le piccole oscillazioni degli accordi tenuti). Lavorando in
// dB il metodo non dipende dal volume.

const FLOOR_DB = -110; // sotto questo livello consideriamo silenzio
const BASS_MAX_HZ = 200; // limite della modalità "solo bassi"
const LAG_MS = 28; // distanza minima del fotogramma di confronto (~30 ms)
const WINDOW_MS = 1500; // finestra della soglia adattiva
const MIN_GAP_MS = 140; // distanza minima tra due battiti (~430 al minuto)
const BPM_WINDOW_MS = 10000;
const RING = 16;

export class BeatDetector {
  /**
   * @param {number} sampleRate frequenza di campionamento dell'AudioContext
   * @param {number} fftSize fftSize dell'AnalyserNode
   */
  constructor(sampleRate, fftSize, { fMin = 40, fMax = 8000, bands = 28 } = {}) {
    const binHz = sampleRate / fftSize;
    const nBins = fftSize / 2;

    // Bordi delle bande in indici di bin, strettamente crescenti
    const edges = [];
    for (let i = 0; i <= bands; i++) {
      const f = fMin * (fMax / fMin) ** (i / bands);
      const bin = Math.min(nBins, Math.max(1, Math.round(f / binHz)));
      if (bin > (edges.at(-1) ?? 0)) edges.push(bin);
    }
    this.bands = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const centre = ((edges[i] + edges[i + 1]) / 2) * binHz;
      this.bands.push({ a: edges[i], b: edges[i + 1], bass: centre <= BASS_MAX_HZ });
    }

    this.ring = Array.from({ length: RING }, () => new Float32Array(this.bands.length));
    this.times = new Float64Array(RING).fill(NaN);
    this.head = 0;

    this.flux = []; // ultimi valori di crescita
    this.fluxT = [];
    this.beats = []; // istanti dei battiti
    this.lastBeat = -Infinity;
    this.lastT = NaN;
    this.maxL = NaN; // livello massimo recente (dB)
    this.minL = NaN; // livello minimo recente (dB)

    /** 0 = pochi battiti, 1 = moltissimi */
    this.sensitivity = 0.5;
    /** true = considera solo le bande sotto 200 Hz (cassa, basso) */
    this.bassOnly = false;
  }

  /**
   * Analizza un fotogramma.
   * @param {Float32Array} db risultato di analyser.getFloatFrequencyData()
   * @param {number} now istante in millisecondi
   * @returns {{beat: boolean, level: number, flux: number, threshold: number}}
   *   level è il volume relativo agli ultimi secondi, da 0 a 1
   */
  process(db, now) {
    const { bands, ring, times } = this;
    const cur = ring[this.head];
    for (let k = 0; k < bands.length; k++) {
      const { a, b } = bands[k];
      let s = 0;
      for (let i = a; i < b; i++) {
        const x = db[i];
        s += x > FLOOR_DB ? x : FLOOR_DB; // gestisce anche -Infinity
      }
      cur[k] = s / (b - a);
    }
    times[this.head] = now;

    // Fotogramma di confronto: il più recente ad almeno LAG_MS di distanza
    let ref = null;
    for (let j = 1; j < RING; j++) {
      const idx = (this.head - j + RING) % RING;
      if (Number.isNaN(times[idx])) break;
      if (now - times[idx] >= LAG_MS) {
        ref = ring[idx];
        break;
      }
    }
    this.head = (this.head + 1) % RING;

    // Crescita media e livello medio sulle bande attive
    const useBass = this.bassOnly && bands.some((x) => x.bass);
    let flux = 0;
    let loud = 0;
    let m = 0;
    for (let k = 0; k < bands.length; k++) {
      if (useBass && !bands[k].bass) continue;
      m++;
      loud += cur[k];
      if (ref) {
        const d = cur[k] - ref[k];
        if (d > 0) flux += d;
      }
    }
    flux /= m;
    loud /= m;

    // Livello relativo: massimo e minimo recenti che si riavvicinano lentamente
    const dt = Number.isNaN(this.lastT) ? 0 : Math.min(0.25, (now - this.lastT) / 1000);
    this.lastT = now;
    if (Number.isNaN(this.maxL)) {
      this.maxL = loud;
      this.minL = loud - 15;
    }
    this.maxL = loud > this.maxL ? loud : this.maxL - 3 * dt;
    this.minL = loud < this.minL ? loud : this.minL + 3 * dt;
    const range = Math.max(10, this.maxL - this.minL);
    const level = clamp01((loud - (this.maxL - range)) / range);

    // Soglia adattiva calcolata sui valori precedenti
    const hist = this.flux;
    while (this.fluxT.length && now - this.fluxT[0] > WINDOW_MS) {
      this.fluxT.shift();
      hist.shift();
    }
    let mean = 0;
    for (const v of hist) mean += v;
    mean /= hist.length || 1;
    let varSum = 0;
    for (const v of hist) varSum += (v - mean) ** 2;
    const std = Math.sqrt(varSum / (hist.length || 1));
    hist.push(flux);
    this.fluxT.push(now);

    // Valori tarati su brani di prova a 30, 60, 90 e 120 fotogrammi al secondo
    const s = this.sensitivity;
    const k = 2.4 - 1.4 * s;
    const ratio = 3 - 1.4 * s;
    const minFlux = 6.5 - 5 * s; // crescita minima in dB
    const threshold = Math.max(mean + k * std, mean * ratio, minFlux);
    const audible = loud > FLOOR_DB + 5 && loud > this.maxL - 35;
    const warm = hist.length >= 10;

    const beat = warm && audible && flux > threshold && now - this.lastBeat >= MIN_GAP_MS;
    if (beat) {
      this.lastBeat = now;
      this.beats.push(now);
    }
    while (this.beats.length && now - this.beats[0] > BPM_WINDOW_MS) this.beats.shift();

    return { beat, level, flux, threshold };
  }

  /** Stima dei battiti al minuto dagli ultimi 10 secondi, o null. */
  bpm(now) {
    const b = this.beats.filter((t) => now - t <= BPM_WINDOW_MS);
    if (b.length < 6) return null;
    // Istogramma degli intervalli (tra battiti vicini), riportati tra 80 e 160
    const votes = new Float32Array(161);
    for (let i = 0; i < b.length; i++) {
      for (let j = i + 1; j < Math.min(b.length, i + 4); j++) {
        const dt = b[j] - b[i];
        if (dt < 200 || dt > 2000) continue;
        let bpm = 60000 / dt;
        while (bpm < 80) bpm *= 2;
        while (bpm >= 160) bpm /= 2;
        const r = Math.round(bpm);
        votes[r] += 1;
        votes[r - 1] += 0.5;
        if (r + 1 < votes.length) votes[r + 1] += 0.5;
      }
    }
    let best = 0;
    for (let r = 80; r < 160; r++) if (votes[r] > votes[best]) best = r;
    return votes[best] >= 3 ? best : null;
  }
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
