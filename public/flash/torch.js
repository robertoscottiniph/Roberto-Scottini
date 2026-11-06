// Controllo del flash (torcia) tramite la traccia video della fotocamera
// posteriore: track.applyConstraints({ advanced: [{ torch: true }] }).
// Funziona con Chrome su Android. Se il telefono o il browser non lo
// permettono, open() restituisce false.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Torch {
  /** @param {HTMLVideoElement} video elemento (invisibile) che riceve la fotocamera */
  constructor(video) {
    this.video = video;
    this.track = null;
    this.current = false; // stato attuale del flash
    this.desired = false; // stato richiesto
    this.flushing = null;
    this.latency = 0; // tempo medio di accensione/spegnimento (ms)
  }

  get live() {
    return !!this.track && this.track.readyState === "live";
  }

  /** Apre la fotocamera con il flash. Lancia NotAllowedError se il permesso è negato. */
  async open() {
    if (this.live) return true;
    if (!navigator.mediaDevices?.getUserMedia) return false;

    const tried = new Set();
    const attempt = async (video) => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (err) {
        if (err.name === "NotAllowedError" || err.name === "SecurityError") throw err;
        return null;
      }
      const track = stream.getVideoTracks()[0];
      tried.add(track.getSettings?.().deviceId);
      if (await this.#hasTorch(track, stream)) return track;
      track.stop();
      return null;
    };

    // Prima la fotocamera posteriore predefinita, poi le altre (alcuni telefoni
    // hanno più fotocamere posteriori e il flash è collegato a una sola)
    let track = await attempt({ facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } });
    if (!track) {
      const cams = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === "videoinput" && d.deviceId && !tried.has(d.deviceId))
        .sort((a, b) => backScore(b.label) - backScore(a.label));
      for (const cam of cams) {
        track = await attempt({ deviceId: { exact: cam.deviceId } });
        if (track) break;
      }
    }
    if (!track) {
      this.video.srcObject = null;
      return false;
    }
    this.track = track;
    this.current = false;
    track.addEventListener("ended", () => {
      if (this.track === track) this.track = null;
    });
    return true;
  }

  async #hasTorch(track, stream) {
    // Su alcuni telefoni la capacità "torch" compare solo quando la fotocamera
    // sta già producendo immagini: la colleghiamo a un <video> e aspettiamo un po'.
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch {}
    for (let i = 0; i < 6; i++) {
      if (track.getCapabilities?.().torch) return true;
      await sleep(100);
    }
    return false;
  }

  /** Accende o spegne il flash. Le richieste ravvicinate vengono accodate. */
  set(on) {
    this.desired = on;
    if (!this.flushing) this.flushing = this.#flush().finally(() => (this.flushing = null));
    return this.flushing;
  }

  /** Riapplica lo stato richiesto (es. quando l'app torna in primo piano). */
  resync() {
    this.current = !this.desired;
    return this.set(this.desired);
  }

  async #flush() {
    while (this.live && this.current !== this.desired) {
      const target = this.desired;
      const t0 = performance.now();
      try {
        await this.track.applyConstraints({ advanced: [{ torch: target }] });
      } catch (err) {
        console.warn("Flash:", err);
        return;
      }
      const ms = performance.now() - t0;
      this.latency = this.latency ? this.latency * 0.8 + ms * 0.2 : ms;
      this.current = target;
    }
  }

  close() {
    this.desired = false;
    this.current = false;
    if (this.track) {
      this.track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
      this.track.stop();
    }
    this.track = null;
    this.video.srcObject = null;
  }
}

function backScore(label = "") {
  if (/back|rear|environment|posterior|retro/i.test(label)) return 1;
  if (/front|user|selfie|anterior/i.test(label)) return -1;
  return 0;
}
