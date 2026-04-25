// ぷにぷに — Puyo-Puyo-style chain dropper (vanilla JS, canvas)
(() => {
  'use strict';

  const COLS = 6, ROWS = 12;
  const CELL = 32;
  const W = COLS * CELL, H = ROWS * CELL;
  const COLORS = ['#ff5577', '#5ad36b', '#5aa9ff', '#ffd95a']; // red green blue yellow
  const COLOR_KEYS = ['R', 'G', 'B', 'Y'];
  const POP_THRESHOLD = 4;

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const nextCanvas = $('next');
  const nctx = nextCanvas.getContext('2d');
  const scoreEl = $('score'), bestEl = $('best'), clearedEl = $('cleared'), chainDisplayEl = $('chain-display');
  const banner = $('banner'), bannerText = $('banner-text');
  const startOv = $('start-overlay'), endOv = $('end-overlay');
  const endTitle = $('end-title'), endScore = $('end-score'), endChain = $('end-chain');
  const btnStart = $('btn-start'), btnAgain = $('btn-again'), btnRestart = $('btn-restart'), btnMute = $('btn-mute');

  // dpr scale
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const [c, w, h] of [[canvas, W, H], [nextCanvas, 56, 84]]) {
    c.width = w * dpr; c.height = h * dpr;
    c.style.width = w + 'px'; c.style.height = h + 'px';
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- Audio ----------
  const Sound = (() => {
    let ac = null, muted = localStorage.getItem('puyo_muted') === '1';
    const en = () => { if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); return ac; };
    const beep = (f, d, t = 'sine', g = 0.13) => {
      if (muted) return;
      const a = en(); const o = a.createOscillator(); const gn = a.createGain();
      o.type = t; o.frequency.value = f; gn.gain.value = g;
      gn.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + d);
      o.connect(gn).connect(a.destination); o.start(); o.stop(a.currentTime + d);
    };
    return {
      prime: en,
      move: () => beep(540, 0.04, 'square', 0.08),
      rotate: () => beep(700, 0.05, 'square', 0.1),
      drop: () => beep(180, 0.1, 'triangle', 0.16),
      pop: (n) => {
        // higher pitch per chain step
        const base = 440 * Math.pow(1.12, Math.min(n, 12));
        [base, base * 1.25, base * 1.5].forEach((f, i) =>
          setTimeout(() => beep(f, 0.12, 'triangle', 0.15), i * 60)
        );
      },
      die: () => [400, 320, 240, 160].forEach((f, i) =>
        setTimeout(() => beep(f, 0.18, 'sawtooth', 0.18), i * 110)),
      toggle: () => { muted = !muted; localStorage.setItem('puyo_muted', muted ? '1' : '0'); return muted; },
      isMuted: () => muted
    };
  })();
  btnMute.textContent = Sound.isMuted() ? '🔇' : '🔊';

  // ---------- State ----------
  // grid[y][x] = null or color index 0..3
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));

  const state = {
    pair: null,        // { ax, ay, bx, by, ca, cb, rot } — axis (a) and sub (b) puyo
    next: null,        // [colorA, colorB]
    fallTimer: 0,
    fallInterval: 38,  // frames between automatic 1-cell drop
    softDrop: false,
    locking: 0,        // small grace before locking
    score: 0,
    best: +(localStorage.getItem('puyo_best') || 0),
    cleared: 0,
    chain: 0,
    maxChain: 0,
    over: false,
    paused: true,
    phase: 'play',     // 'play' | 'lock' | 'pop' | 'gravity'
    popTimer: 0,
    popList: [],
    keys: { left: false, right: false, down: false }
  };
  bestEl.textContent = state.best;

  function randomColorPair() {
    return [Math.floor(Math.random() * COLORS.length), Math.floor(Math.random() * COLORS.length)];
  }
  function spawnPair() {
    if (!state.next) state.next = randomColorPair();
    const [ca, cb] = state.next;
    state.next = randomColorPair();
    state.pair = {
      ax: 2, ay: 1,         // axis at column 2, row 1 (top)
      bx: 2, by: 0,         // sub above axis
      ca, cb, rot: 0        // rot 0 = sub above axis. 1=right, 2=below, 3=left
    };
    if (collides(state.pair)) {
      // game over
      endGame();
    }
  }

  function collides(p) {
    return [[p.ax, p.ay], [p.bx, p.by]].some(([x, y]) => {
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y < 0) return false;
      return grid[y][x] !== null;
    });
  }

  function tryMove(dx) {
    if (!state.pair || state.phase !== 'play') return;
    const t = { ...state.pair, ax: state.pair.ax + dx, bx: state.pair.bx + dx };
    if (!collides(t)) {
      state.pair = t;
      Sound.move();
    }
  }
  function tryRotate(dir) {
    if (!state.pair || state.phase !== 'play') return;
    // rot direction: +1 clockwise (0->1->2->3)
    const p = state.pair;
    const rot = ((p.rot + dir) % 4 + 4) % 4;
    const offsets = [
      { dx: 0, dy: -1 },  // 0 above
      { dx: 1, dy: 0 },   // 1 right
      { dx: 0, dy: 1 },   // 2 below
      { dx: -1, dy: 0 }   // 3 left
    ];
    const o = offsets[rot];
    const t = { ...p, rot, bx: p.ax + o.dx, by: p.ay + o.dy };
    if (!collides(t)) { state.pair = t; Sound.rotate(); return; }
    // wall kick: shift axis horizontally if blocked
    for (const dx of [-1, 1, -2, 2]) {
      const k = { ...t, ax: t.ax + dx, bx: t.bx + dx };
      if (!collides(k)) { state.pair = k; Sound.rotate(); return; }
    }
    // floor kick: lift the pair if blocked below
    const k = { ...t, ax: t.ax, ay: t.ay - 1, bx: t.bx, by: t.by - 1 };
    if (!collides(k)) { state.pair = k; Sound.rotate(); }
  }

  function softDropTick() {
    if (!state.pair || state.phase !== 'play') return;
    const t = { ...state.pair, ay: state.pair.ay + 1, by: state.pair.by + 1 };
    if (!collides(t)) {
      state.pair = t;
      state.score += 1;
    } else {
      lockPair();
    }
  }

  function hardDrop() {
    if (!state.pair || state.phase !== 'play') return;
    let dropped = 0;
    while (true) {
      const t = { ...state.pair, ay: state.pair.ay + 1, by: state.pair.by + 1 };
      if (collides(t)) break;
      state.pair = t;
      dropped++;
    }
    state.score += dropped * 2;
    Sound.drop();
    lockPair();
  }

  function placeOnGrid(p) {
    // Place axis first, then sub. If sub is above grid (y<0) we don't place but
    // it still matters for game-over check.
    if (p.ay >= 0 && p.ay < ROWS) grid[p.ay][p.ax] = p.ca;
    if (p.by >= 0 && p.by < ROWS) grid[p.by][p.bx] = p.cb;
  }
  function lockPair() {
    if (!state.pair) return;
    placeOnGrid(state.pair);
    state.pair = null;
    state.phase = 'gravity';
    Sound.drop();
  }

  function applyGravity() {
    let moved = false;
    for (let x = 0; x < COLS; x++) {
      let writeY = ROWS - 1;
      for (let y = ROWS - 1; y >= 0; y--) {
        if (grid[y][x] !== null) {
          if (writeY !== y) {
            grid[writeY][x] = grid[y][x];
            grid[y][x] = null;
            moved = true;
          }
          writeY--;
        }
      }
    }
    return moved;
  }

  // Find connected groups via flood-fill.
  function findGroups() {
    const seen = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    const groups = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (seen[y][x] || grid[y][x] === null) continue;
        const color = grid[y][x];
        const stack = [[x, y]];
        const cells = [];
        while (stack.length) {
          const [cx, cy] = stack.pop();
          if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) continue;
          if (seen[cy][cx] || grid[cy][cx] !== color) continue;
          seen[cy][cx] = true;
          cells.push([cx, cy]);
          stack.push([cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]);
        }
        if (cells.length >= POP_THRESHOLD) groups.push({ color, cells });
      }
    }
    return groups;
  }

  function chainScore(chainStep, totalCleared, colors) {
    // Loose-but-puyo-flavored scoring: cleared * 10 * (chainBonus + colorBonus + groupBonus)
    const chainTable = [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352];
    const cb = chainTable[Math.min(chainStep, chainTable.length - 1)] || 352;
    const colorBonus = [0, 0, 3, 6, 12, 24][colors] || 24;
    return totalCleared * 10 * Math.max(1, cb + colorBonus);
  }

  // ---------- Phase machinery ----------
  function tickPlay() {
    if (state.phase !== 'play' || !state.pair) return;
    state.fallTimer++;
    const interval = state.softDrop ? 4 : state.fallInterval;
    if (state.fallTimer >= interval) {
      state.fallTimer = 0;
      const t = { ...state.pair, ay: state.pair.ay + 1, by: state.pair.by + 1 };
      if (!collides(t)) {
        state.pair = t;
      } else {
        // small grace before lock
        state.locking++;
        if (state.locking > 6 || state.softDrop) {
          state.locking = 0;
          lockPair();
        }
      }
    }
  }

  function tickGravity() {
    const moved = applyGravity();
    if (moved) {
      // Stay in gravity phase a bit so it visually drops, then check pops.
      // For simplicity, jump straight to checking pops without animation.
    }
    state.phase = 'check';
  }

  function tickCheck() {
    const groups = findGroups();
    if (groups.length === 0) {
      // No more pops — back to play with new pair
      state.chain = 0;
      chainDisplayEl.textContent = 0;
      state.phase = 'play';
      spawnPair();
      return;
    }
    // Pop these groups
    state.chain++;
    if (state.chain > state.maxChain) state.maxChain = state.chain;
    chainDisplayEl.textContent = state.chain;
    state.popList = groups;
    state.popTimer = 18; // frames to flash
    state.phase = 'pop';
    Sound.pop(state.chain);
    if (state.chain >= 2) showBanner(`${state.chain} れんさ！`, 'chain', 600);
  }

  function tickPop() {
    state.popTimer--;
    if (state.popTimer <= 0) {
      // Clear popped cells
      let totalCleared = 0;
      const colorsHit = new Set();
      for (const g of state.popList) {
        colorsHit.add(g.color);
        for (const [x, y] of g.cells) {
          grid[y][x] = null;
          totalCleared++;
        }
      }
      state.cleared += totalCleared;
      state.score += chainScore(state.chain, totalCleared, colorsHit.size);
      state.popList = [];
      state.phase = 'gravity';
    }
  }

  // ---------- Render ----------
  function drawPuyo(c, x, y, color, alpha = 1, flash = false) {
    const cx = x * CELL + CELL / 2;
    const cy = y * CELL + CELL / 2;
    const r = CELL / 2 - 3;
    c.save();
    c.globalAlpha = alpha;
    const fill = flash ? '#fff' : color;
    const grad = c.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 1, cx, cy, r);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(0.3, fill);
    grad.addColorStop(1, fill);
    c.fillStyle = grad;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    c.lineWidth = 1.5;
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.stroke();
    // eyes
    if (!flash) {
      c.fillStyle = '#fff';
      c.beginPath(); c.arc(cx - r * 0.35, cy - r * 0.15, r * 0.22, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(cx + r * 0.35, cy - r * 0.15, r * 0.22, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#000';
      c.beginPath(); c.arc(cx - r * 0.32, cy - r * 0.1, r * 0.1, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(cx + r * 0.38, cy - r * 0.1, r * 0.1, 0, Math.PI * 2); c.fill();
    }
    c.restore();
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    // Grid background
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(0, 0, W, H);
    // Subtle grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let x = 1; x < COLS; x++) {
      ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, H); ctx.stroke();
    }
    for (let y = 1; y < ROWS; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(W, y * CELL); ctx.stroke();
    }
    // Placed puyos
    const popping = new Set();
    if (state.phase === 'pop') {
      for (const g of state.popList) for (const [x, y] of g.cells) popping.add(`${x},${y}`);
    }
    const flashOn = state.phase === 'pop' && Math.floor(state.popTimer / 4) % 2 === 0;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const c = grid[y][x];
        if (c === null) continue;
        const isPop = popping.has(`${x},${y}`);
        drawPuyo(ctx, x, y, COLORS[c], 1, isPop && flashOn);
      }
    }
    // Falling pair
    if (state.pair && state.phase === 'play') {
      const p = state.pair;
      drawPuyo(ctx, p.ax, p.ay, COLORS[p.ca]);
      drawPuyo(ctx, p.bx, p.by, COLORS[p.cb]);
    }
    // Next preview
    nctx.clearRect(0, 0, 56, 84);
    nctx.fillStyle = 'rgba(0,0,0,0)';
    if (state.next) {
      const [na, nb] = state.next;
      // sub on top, axis below
      drawPuyo(nctx, 0, 0, COLORS[nb]);
      drawPuyo(nctx, 0, 1, COLORS[na]);
    }
  }

  // ---------- Banner ----------
  function showBanner(t, cls, ms = 1100) {
    bannerText.textContent = t;
    banner.classList.remove('go', 'chain');
    if (cls) banner.classList.add(cls);
    banner.classList.add('show');
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => banner.classList.remove('show'), ms);
  }

  // ---------- Game over ----------
  function endGame() {
    state.over = true;
    state.paused = true;
    Sound.die();
    if (state.score > state.best) {
      state.best = state.score;
      localStorage.setItem('puyo_best', String(state.best));
    }
    bestEl.textContent = state.best;
    endTitle.textContent = 'ぷにっ…';
    endScore.textContent = state.score;
    endChain.textContent = state.maxChain;
    endOv.classList.add('show');
  }

  // ---------- Reset ----------
  function resetGame() {
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) grid[y][x] = null;
    state.pair = null;
    state.next = null;
    state.fallTimer = 0;
    state.fallInterval = 38;
    state.softDrop = false;
    state.locking = 0;
    state.score = 0;
    state.cleared = 0;
    state.chain = 0;
    state.maxChain = 0;
    state.phase = 'play';
    state.popList = [];
    state.popTimer = 0;
    state.over = false;
    state.paused = false;
    chainDisplayEl.textContent = 0;
    spawnPair();
    updateHud();
  }
  function updateHud() {
    scoreEl.textContent = state.score;
    bestEl.textContent = state.best;
    clearedEl.textContent = state.cleared;
  }

  // ---------- Main loop ----------
  function loop() {
    if (!state.paused && !state.over) {
      switch (state.phase) {
        case 'play':    tickPlay();    break;
        case 'gravity': tickGravity(); break;
        case 'check':   tickCheck();   break;
        case 'pop':     tickPop();     break;
      }
    }
    render();
    updateHud();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- Input ----------
  function handle(act) {
    if (state.paused || state.over) return;
    Sound.prime();
    switch (act) {
      case 'left':  tryMove(-1); break;
      case 'right': tryMove(1); break;
      case 'down':  state.softDrop = true; softDropTick(); break;
      case 'drop':  hardDrop(); break;
      case 'rotL':  tryRotate(-1); break;
      case 'rotR':  tryRotate(1); break;
    }
  }
  document.querySelectorAll('.pad-btn').forEach((b) => {
    const act = b.dataset.act;
    let repeat = null;
    const press = (e) => {
      e.preventDefault();
      handle(act);
      if (act === 'left' || act === 'right' || act === 'down') {
        repeat = setInterval(() => handle(act), 90);
      }
    };
    const release = () => {
      if (repeat) { clearInterval(repeat); repeat = null; }
      if (act === 'down') state.softDrop = false;
    };
    b.addEventListener('touchstart', press, { passive: false });
    b.addEventListener('touchend', release);
    b.addEventListener('touchcancel', release);
    b.addEventListener('mousedown', press);
    b.addEventListener('mouseup', release);
    b.addEventListener('mouseleave', release);
  });
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft')  { handle('left'); e.preventDefault(); }
    else if (k === 'ArrowRight') { handle('right'); e.preventDefault(); }
    else if (k === 'ArrowDown')  { handle('down'); e.preventDefault(); }
    else if (k === ' ' || k === 'Spacebar') { handle('drop'); e.preventDefault(); }
    else if (k === 'z' || k === 'Z') handle('rotL');
    else if (k === 'x' || k === 'X' || k === 'ArrowUp') handle('rotR');
  }, { passive: false });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowDown') state.softDrop = false;
  });

  btnStart.addEventListener('click', () => { Sound.prime(); startOv.classList.remove('show'); resetGame(); });
  btnAgain.addEventListener('click', () => { Sound.prime(); endOv.classList.remove('show'); resetGame(); });
  btnRestart.addEventListener('click', () => {
    if (!confirm('リスタートしますか？')) return;
    endOv.classList.remove('show');
    resetGame();
  });
  btnMute.addEventListener('click', () => {
    const m = Sound.toggle();
    btnMute.textContent = m ? '🔇' : '🔊';
  });

  // Static initial render
  render();
})();
