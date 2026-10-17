// ═══════════════════════════════════════════════
//  landing.js — landing page demos
//  Plays fixed examples the same way the editor does: one beat per
//  line, and a line with an error distorts the music while it plays.
//  No server calls, so visitors can try it without an account.
// ═══════════════════════════════════════════════
(function () {
  // Logged-in visitors get "Open the editor" instead of sign-up buttons.
  try {
    if (localStorage.getItem('cb_token')) {
      document.querySelectorAll('.ld-guest').forEach(el => { el.hidden = true; });
      document.querySelectorAll('.ld-member').forEach(el => { el.hidden = false; });
    }
  } catch (e) {}

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Sound ──────────────────────────────────────
  // Same values as SEVERITY_FX in app.js, so the demos sound like the app.
  const FX = {
    clean: { distortion: 0,    pitch: 0,  wet: 0,    stayMs: 300 },
    error: { distortion: 0.55, pitch: -5, wet: 0.55, stayMs: 1000 }
  };

  let audio = null;   // synths + effects, built on the first play
  let current = null; // the player that is playing now, if any

  function buildAudio() {
    const limiter    = new Tone.Limiter(-2).toDestination();
    const reverb     = new Tone.Reverb({ decay: 2.0, wet: 0.45 }).connect(limiter);
    const distortion = new Tone.Distortion({ distortion: 0, wet: 0 }).connect(reverb);
    const pitchShift = new Tone.PitchShift({ pitch: 0, windowSize: 0.1 }).connect(distortion);

    const bass = new Tone.Synth({ oscillator: { type: 'triangle' },
      envelope: { attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.5 }, volume: -10 }).connect(pitchShift);
    const pad = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'triangle' },
      envelope: { attack: 0.3, decay: 0.5, sustain: 0.7, release: 1.5 }, volume: -20 }).connect(pitchShift);
    const kick = new Tone.MembraneSynth({ pitchDecay: 0.06, octaves: 8,
      envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.1 }, volume: -12 }).connect(limiter);
    const snare = new Tone.NoiseSynth({ noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.18, sustain: 0.02, release: 0.05 }, volume: -17 }).connect(reverb);
    const hat = new Tone.MetalSynth({ frequency: 400, envelope: { attack: 0.001, decay: 0.04, release: 0.01 },
      harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5, volume: -22 }).connect(limiter);

    // Lo-fi Chill, the app's default style
    const bassLine = ['C2', 'C2', 'Bb1', 'Bb1', 'Ab1', 'Ab1', 'G1', 'G1'];
    const pads = [['C4', 'Eb4', 'G4'], ['Bb3', 'D4', 'F4'], ['Ab3', 'C4', 'Eb4'], ['G3', 'Bb3', 'D4']];
    const kicks = [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0];
    const snares = [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0];

    const seqs = [
      new Tone.Sequence((t, i) => bass.triggerAttackRelease(bassLine[i], '8n', t), [...Array(8).keys()], '8n'),
      new Tone.Sequence((t, i) => pad.triggerAttackRelease(pads[i], '2n', t), [...Array(4).keys()], '2n'),
      new Tone.Sequence((t, i) => {
        if (kicks[i]) kick.triggerAttackRelease('C1', '8n', t);
        if (snares[i]) snare.triggerAttackRelease('16n', t);
        hat.triggerAttackRelease('32n', t);
      }, [...Array(16).keys()], '16n')
    ];

    return { distortion, pitchShift, pad, kick, snare, seqs };
  }

  function setFx(sev) {
    const fx = FX[sev];
    audio.distortion.distortion = fx.distortion;
    audio.distortion.wet.value = fx.wet;
    audio.pitchShift.pitch = fx.pitch;
    if (sev === 'error') {
      const now = Tone.now() + 0.01;
      audio.pad.triggerAttackRelease(['Eb3', 'Bb3'], '8n', now);
      audio.kick.triggerAttackRelease('C1', '8n', now);
      audio.snare.triggerAttackRelease('8n', now + 0.03);
    }
  }

  // A player steps through a list of severities, one beat per line.
  // Only one player sounds at a time; starting one stops the other.
  function makePlayer({ severities, loop, onStep, onStart, onStop }) {
    let timer = null, step = 0, playing = false;

    function tick() {
      const list = severities();
      if (step >= list.length) {
        if (!loop) { stop(); return; }
        step = 0;
      }
      const sev = list[step];
      setFx(sev);
      onStep(step, sev);
      step++;
      timer = setTimeout(tick, FX[sev].stayMs);
    }

    async function start() {
      if (!window.Tone) return false;
      if (current && current !== player) current.stop();
      await Tone.start();
      if (!audio) audio = buildAudio();
      Tone.getTransport().bpm.value = 85;
      audio.seqs.forEach(s => s.start(0));
      Tone.getTransport().start();
      current = player;
      playing = true;
      step = 0;
      onStart();
      tick();
      return true;
    }

    function stop() {
      clearTimeout(timer);
      if (audio && current === player) {
        Tone.getTransport().stop();
        audio.seqs.forEach(s => s.stop());
        setFx('clean');
        current = null;
      }
      playing = false;
      onStop();
    }

    const player = { start, stop, isPlaying: () => playing };
    return player;
  }

  // ── "Listen to a bug" demo ─────────────────────
  const VERSIONS = {
    buggy: {
      lines: [
        'def find_max(numbers):',
        '    largest = 0',
        '    for n in numbers:',
        '        if n > largest:',
        '            largest = n',
        '    return largest',
        '',
        'print(find_max([-4, -9, -2]))   # prints 0'
      ],
      issues: {
        2: 'Line 2 · Logic error: largest starts at 0, so a list with only negative numbers never beats it and the function returns 0. Fix: largest = numbers[0]'
      }
    },
    fixed: {
      lines: [
        'def find_max(numbers):',
        '    largest = numbers[0]',
        '    for n in numbers:',
        '        if n > largest:',
        '            largest = n',
        '    return largest',
        '',
        'print(find_max([-4, -9, -2]))   # prints -2'
      ],
      issues: {}
    }
  };

  const codeEl  = document.getElementById('ld-code');
  const waveEl  = document.getElementById('ld-wave');
  const issueEl = document.getElementById('ld-issue');
  const playBtn = document.getElementById('ld-play');
  const segBtns = document.querySelectorAll('.ld-seg__btn');
  let version = 'buggy';

  function severityOf(n) { return VERSIONS[version].issues[n] ? 'error' : 'clean'; }

  function render() {
    const v = VERSIONS[version];
    codeEl.innerHTML = '';
    waveEl.innerHTML = '';
    v.lines.forEach((text, i) => {
      const n = i + 1;
      const line = document.createElement('span');
      line.className = 'ld-line ld-line--' + severityOf(n);
      line.dataset.n = n;
      line.textContent = text || ' ';
      codeEl.appendChild(line);

      const bar = document.createElement('span');
      bar.className = 'ld-bar ld-bar--' + severityOf(n);
      waveEl.appendChild(bar);
    });
    issueEl.textContent = Object.keys(v.issues).length
      ? 'Press play to hear it.'
      : 'No issues found. The beat stays clean the whole way through.';
  }

  function highlight(n) {
    codeEl.querySelectorAll('.ld-line').forEach(el => el.classList.toggle('is-active', +el.dataset.n === n));
    waveEl.querySelectorAll('.ld-bar').forEach((el, i) => el.classList.toggle('is-active', i + 1 === n));
  }

  const demo = makePlayer({
    loop: true,
    severities: () => VERSIONS[version].lines.map((_, i) => severityOf(i + 1)),
    onStep: (i, sev) => {
      highlight(i + 1);
      if (sev === 'error') issueEl.textContent = VERSIONS[version].issues[i + 1];
    },
    onStart: () => { playBtn.textContent = '■ Stop'; },
    onStop: () => { playBtn.textContent = '▶ Play'; highlight(0); }
  });

  playBtn.addEventListener('click', async () => {
    if (demo.isPlaying()) return demo.stop();
    if (!(await demo.start())) issueEl.textContent = 'The audio library did not load. Check your connection and refresh the page.';
  });

  segBtns.forEach(btn => btn.addEventListener('click', () => {
    const wasPlaying = demo.isPlaying();
    if (wasPlaying) demo.stop();
    version = btn.dataset.version;
    segBtns.forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    render();
    if (wasPlaying) demo.start();
  }));

  render();

  // ── "How it works" steps ───────────────────────
  // The same bug in every language the editor supports.
  const FLOW = {
    python:     ['def find_max(numbers):',          '    largest = 0',        'largest = numbers[0]'],
    javascript: ['function findMax(numbers) {',     '  let largest = 0;',     'let largest = numbers[0];'],
    typescript: ['function findMax(nums: number[]) {', '  let largest = 0;',  'let largest = nums[0];'],
    java:       ['int findMax(int[] numbers) {',    '    int largest = 0;',   'int largest = numbers[0];'],
    c:          ['int find_max(int n[], int len) {', '    int largest = 0;',  'int largest = n[0];'],
    cpp:        ['int findMax(vector<int> nums) {', '    int largest = 0;',   'int largest = nums[0];'],
    kotlin:     ['fun findMax(nums: List<Int>): Int {', '    var largest = 0', 'var largest = nums[0]'],
    php:        ['function findMax($numbers) {',    '    $largest = 0;',      '$largest = $numbers[0];']
  };

  const langSel = document.getElementById('ld-flow-lang');
  const l1 = document.getElementById('ld-flow-l1');
  const l2 = document.getElementById('ld-flow-l2');
  const caret = document.getElementById('ld-flow-caret');
  const fixEl = document.getElementById('ld-flow-fix');
  const issueBox = document.getElementById('ld-flow-issue');
  const waveBox = document.getElementById('ld-flow-wave');
  const miniPlay = document.getElementById('ld-flow-play');
  const miniBars = waveBox.querySelectorAll('.ld-mini__bars i');
  let typing = null;

  function typeOut(lang, speed) {
    clearTimeout(typing);
    const [a, b, fix] = FLOW[lang];
    issueBox.classList.add('ld-wait');
    waveBox.classList.add('ld-wait');
    fixEl.textContent = fix;
    const full = a + '\n' + b;
    let i = 0;
    (function next() {
      const shown = full.slice(0, i);
      const [x, y = ''] = shown.split('\n');
      l1.textContent = x;
      l2.textContent = y;
      if (i < full.length) {
        i++;
        typing = setTimeout(next, speed);
      } else {
        caret.hidden = true;
        issueBox.classList.remove('ld-wait');
        typing = setTimeout(() => waveBox.classList.remove('ld-wait'), reduceMotion ? 0 : 450);
      }
    })();
    caret.hidden = false;
  }

  function showNow(lang) {
    const [a, b, fix] = FLOW[lang];
    l1.textContent = a;
    l2.textContent = b;
    fixEl.textContent = fix;
    caret.hidden = true;
    issueBox.classList.remove('ld-wait');
    waveBox.classList.remove('ld-wait');
  }

  langSel.addEventListener('change', () => {
    if (reduceMotion) showNow(langSel.value);
    else typeOut(langSel.value, 18);
  });

  // Type the example in the first time the steps scroll into view.
  if (reduceMotion || !('IntersectionObserver' in window)) {
    showNow('python');
  } else {
    l1.textContent = '';
    l2.textContent = '';
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        io.disconnect();
        typeOut(langSel.value, 40);
      }
    }, { threshold: 0.6 });
    io.observe(langSel.closest('.ld-mini'));
  }

  const mini = makePlayer({
    loop: false,
    severities: () => [...miniBars].map(b => b.classList.contains('e') ? 'error' : 'clean'),
    onStep: (i, sev) => {
      miniBars.forEach((b, j) => b.classList.toggle('is-active', j === i));
      if (sev === 'error') {
        const bar = miniBars[i];
        bar.classList.remove('is-hit');
        void bar.offsetWidth; // restart the pulse animation
        bar.classList.add('is-hit');
      }
    },
    onStart: () => { miniPlay.textContent = '■'; miniPlay.setAttribute('aria-label', 'Stop the beat'); },
    onStop: () => {
      miniPlay.textContent = '▶';
      miniPlay.setAttribute('aria-label', 'Play the beat for this example');
      miniBars.forEach(b => b.classList.remove('is-active'));
    }
  });

  miniPlay.addEventListener('click', () => { mini.isPlaying() ? mini.stop() : mini.start(); });
})();
