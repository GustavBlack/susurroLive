'use strict';
/**
 * Engine selector: routes transcription to the configured ASR engine behind the ONE contract
 * the pipeline already speaks — transcribe(audioPath, opts) -> {engine, words, text, language}.
 *
 * Engines are peers: whisper.cpp (primary) and parakeet (sherpa-onnx sidecar). The route is
 * decided per call from opts.engine, falling back to the `engine` setting, falling back to
 * whisper. When the chosen engine is unavailable the selector falls back to whisper's status
 * reason — the pipeline's DEMO mode stays the single "nothing is available" story.
 *
 * The pipeline/assemble/session layers never import engine modules directly; `res.engine`
 * (per chunk) is the only trace of which engine ran.
 */
class EngineSelector {
  /**
   * @param {object} deps
   * @param {import('../whisper').Engine} deps.whisper
   * @param {import('./parakeet').ParakeetEngine} [deps.parakeet]
   * @param {() => object} deps.getSettings  returns the settings object (get(k) supported)
   */
  constructor({ whisper, parakeet, getSettings }) {
    this.whisper = whisper;
    this.parakeet = parakeet || null;
    this.getSettings = getSettings;
  }

  /** Resolve which engine should run: opts.engine > setting > 'whisper'. */
  route(opts = {}) {
    const want = String(opts.engine || this.getSettings().get('engine') || 'whisper').toLowerCase();
    if (want === 'parakeet' && this.parakeet) return this.parakeet;
    return this.whisper;
  }

  /** The chosen engine ran; if it was unavailable, fall back to whisper (which may DEMO). */
  async transcribe(audioPath, opts = {}) {
    const chosen = this.route(opts);
    if (chosen !== this.whisper && !chosen.status().available) {
      // Requested engine is not provisioned: whisper handles it (real or DEMO).
      return this.whisper.transcribe(audioPath, opts);
    }
    return chosen.transcribe(audioPath, opts);
  }

  /** Combined status for Settings diagnostics: keys per engine + the active route. */
  status() {
    const settings = this.getSettings();
    const active = String(settings.get('engine') || 'whisper').toLowerCase();
    return {
      active,
      whisper: this.whisper.status(),
      parakeet: this.parakeet ? this.parakeet.status() : { available: false, binary: null, model: null, reason: 'not built into this run' },
    };
  }
}

module.exports = { EngineSelector };
