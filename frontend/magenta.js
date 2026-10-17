// ═══════════════════════════════════════════════
//  magenta.js — AI music infilling with Magenta.js
//  After an analysis, Magenta continues the current music style:
//    • DrumsRNN writes a second drum bar that answers the style's own bar
//    • MelodyRNN continues the style's lead line with 8 new notes
//  The riskier the code, the higher the "temperature" (more surprising
//  choices). The bug signal itself (distortion, pitch drop, accents on
//  flagged lines) is untouched — that stays in app.js.
//
//  The libraries and models load only on first use, in the background.
//  If anything fails (offline, blocked CDN), generate() resolves to null
//  and app.js keeps playing the preset patterns.
// ═══════════════════════════════════════════════
(function () {
  // Magenta 1.23.1 is built against TensorFlow.js 2.x.
  const SCRIPTS = [
    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@2.7.0/dist/tf.min.js',
    'https://cdn.jsdelivr.net/npm/@magenta/music@1.23.1/es6/core.js',
    'https://cdn.jsdelivr.net/npm/@magenta/music@1.23.1/es6/music_rnn.js'
  ];
  const CKPT = 'https://storage.googleapis.com/magentadata/js/checkpoints/music_rnn/';

  // Magenta drum classes (first pitch of each class) -> BugBeat drum parts.
  const DRUM_PITCH = { kick: 36, snare: 38, hihat: 42, openHat: 46 };
  const PITCH_TO_PART = { 36: 'kick', 35: 'kick', 38: 'snare', 40: 'snare', 37: 'snare',
                          42: 'hihat', 44: 'hihat', 46: 'openHat', 49: 'openHat', 51: 'openHat' };
  const STEPS = 16;                    // one bar of 16th notes
  const MELODY_MIN = 48, MELODY_MAX = 83; // range the melody model accepts

  let ready = null;   // Promise<{ drums, melody }> once loading has started

  // The editor page uses Monaco's AMD loader, which defines a global
  // `define`. These libraries would then register themselves as AMD
  // modules instead of globals (and clash with Monaco), so each one runs
  // with `define`, `module` and `exports` hidden.
  async function loadScript(src) {
    const res = await fetch(src);
    if (!res.ok) throw new Error('Could not load ' + src);
    const code = await res.text();
    new Function('define', 'module', 'exports', code).call(window);
  }

  function load() {
    if (!ready) {
      ready = (async () => {
        for (const src of SCRIPTS) await loadScript(src);  // in order: tf, core, music_rnn
        const drums  = new music_rnn.MusicRNN(CKPT + 'drum_kit_rnn');
        const melody = new music_rnn.MusicRNN(CKPT + 'basic_rnn');
        await Promise.all([drums.initialize(), melody.initialize()]);
        return { drums, melody };
      })();
      ready.catch(() => { ready = null; });   // allow a retry on the next analysis
    }
    return ready;
  }

  function quantized(notes, steps) {
    return { notes, totalQuantizedSteps: steps, quantizationInfo: { stepsPerQuarter: 4 } };
  }

  // { kick:[16], snare:[16], ... } -> Magenta drum sequence
  function patternToSeq(pattern) {
    const notes = [];
    for (const part of Object.keys(DRUM_PITCH)) {
      (pattern[part] || []).forEach((on, step) => {
        if (on) notes.push({ pitch: DRUM_PITCH[part], quantizedStartStep: step,
                             quantizedEndStep: step + 1, isDrum: true });
      });
    }
    return quantized(notes, STEPS);
  }

  // Magenta drum sequence -> { kick:[16], snare:[16], ... }
  function seqToPattern(seq) {
    const out = { kick: [], snare: [], hihat: [], openHat: [] };
    for (const part in out) out[part] = new Array(STEPS).fill(0);
    for (const n of seq.notes || []) {
      const part = PITCH_TO_PART[n.pitch];
      if (part) out[part][((n.quantizedStartStep % STEPS) + STEPS) % STEPS] = 1;
    }
    return out;
  }

  // Note names <-> MIDI numbers (Tone is already on the page).
  const toMidi = name => Tone.Frequency(name).toMidi();
  const toName = midi => Tone.Frequency(midi, 'midi').toNote();

  // Shift by whole octaves so every note fits the melody model's range.
  function octaveShift(midis) {
    let shift = 0;
    while (Math.max(...midis) + shift > MELODY_MAX) shift -= 12;
    while (Math.min(...midis) + shift < MELODY_MIN) shift += 12;
    return shift;
  }

  async function continueMelody(model, leadNotes, temperature) {
    const midis = leadNotes.map(toMidi);
    const shift = octaveShift(midis);
    // the style's 8 lead notes as eighth notes = one bar
    const seed = quantized(midis.map((m, i) => ({
      pitch: m + shift, quantizedStartStep: i * 2, quantizedEndStep: i * 2 + 2
    })), STEPS);
    const cont = await model.continueSequence(seed, STEPS, temperature);
    const picked = (cont.notes || [])
      .sort((a, b) => a.quantizedStartStep - b.quantizedStartStep)
      .map(n => toName(n.pitch - shift));
    // always 8 notes: pad with the style's own notes if the model left gaps
    while (picked.length < leadNotes.length) picked.push(leadNotes[picked.length]);
    return picked.slice(0, leadNotes.length);
  }

  // Risk level of the analysed code -> how adventurous Magenta may be.
  const TEMPERATURE = { low: 0.8, medium: 1.0, high: 1.2, critical: 1.4 };

  async function generate({ loopPattern, leadNotes, risk }) {
    try {
      const models = await load();
      const temperature = TEMPERATURE[risk] || 1.0;
      const drumCont = await models.drums.continueSequence(patternToSeq(loopPattern), STEPS, temperature);
      const lead = await continueMelody(models.melody, leadNotes, temperature);
      return { drums: seqToPattern(drumCont), lead, temperature, risk };
    } catch (err) {
      console.warn('Magenta groove not available, using the preset:', err.message);
      return null;
    }
  }

  window.BugBeatMagenta = { generate };
})();
