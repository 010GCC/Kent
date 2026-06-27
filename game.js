// KENT // EXTERMINATOR — v6 full game (zigzag-jump model)

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const W = canvas.width;   // 360
const H = canvas.height;  // 540

// ─── Tuning constants ────────────────────────────────────────────────────────
const GRAVITY        = 0.55;
const JUMP_MIN       = 8.5;
const JUMP_MAX       = 11.0;
const JUMP_HOLD_MS   = 160;
const WALK_SPEED     = 2.8;
const AIR_SPEED      = 2.6;
const MAX_FALL       = 14;
const WALL_SLIDE_MAX = 1.5;
const WALL_KICK_X    = 4.2;
const WALL_KICK_Y    = 8.2;

const LEVEL_HEIGHT   = 58;
const WIDE_GAP       = 90;
const WIDE_GAP_START = 5;
const WIDE_GAP_FREQ  = 0.18;

const WALL_LEFT_X    = 18;
const WALL_RIGHT_X   = W - 18;
const WALL_CONTACT   = 6;

const PLATFORM_W_NORM = 72;
const PLATFORM_W_WIDE = 88;

const LEFT_BAND_X    = [WALL_LEFT_X + 12, W / 2 - 24];
const RIGHT_BAND_X   = [W / 2 + 24, WALL_RIGHT_X - 84];

const KENT_W = 18;
const KENT_H = 26;

const GOO_START_Y    = 120;
const GOO_BASE_SPEED = 0.15;

const SPRAY_COOLDOWN = 18;
const NOZZLE_USES    = 8;

// ─── Data tables ─────────────────────────────────────────────────────────────
const PEST_TYPES = [
  { minPlat: 0,  id: 'ant',    name: 'ANT',    pw: 9,  ph: 6,  color: '#cc4422', pts: 3,  bonus: 3,  resists: null,    bonusNozzle: 'foam'  },
  { minPlat: 4,  id: 'roach',  name: 'ROACH',  pw: 14, ph: 7,  color: '#5a3a1a', pts: 5,  bonus: 5,  resists: 'foam',  bonusNozzle: 'acid'  },
  { minPlat: 8,  id: 'fly',    name: 'FLY',    pw: 10, ph: 7,  color: '#888888', pts: 4,  bonus: 4,  resists: 'foam',  bonusNozzle: 'vapor' },
  { minPlat: 12, id: 'spider', name: 'SPIDER', pw: 12, ph: 10, color: '#222222', pts: 6,  bonus: 6,  resists: 'acid',  bonusNozzle: 'vapor' },
  { minPlat: 18, id: 'wasp',   name: 'WASP',   pw: 12, ph: 8,  color: '#ddaa00', pts: 8,  bonus: 8,  resists: 'vapor', bonusNozzle: 'blast' },
  { minPlat: 25, id: 'rat',    name: 'RAT',    pw: 16, ph: 11, color: '#887070', pts: 10, bonus: 10, resists: 'blast', bonusNozzle: 'acid'  },
];

const NOZZLES = {
  foam:  { name: 'FOAM',  color: '#e8e8cc' },
  acid:  { name: 'ACID',  color: '#88ff44' },
  vapor: { name: 'VAPOR', color: '#88ccff' },
  blast: { name: 'BLAST', color: '#ff8844' },
};

// ─── Leaderboard stub ────────────────────────────────────────────────────────
const Leaderboard = {
  load()                       { return Promise.resolve([]); },
  submit(name, pts, platform)  { /* swap: Firebase */ },
};

// ─── World state ─────────────────────────────────────────────────────────────
let platforms = [];
let kent;
let goo;
let camera;
let score;
let highScore = 0;
let gameTick;
let gameState;  // 'PLAYING' | 'DEAD'
let sprayCooldown = 0;
let sprayVisual = 0;  // frames remaining for spray beam draw
let frameCount = 0;

// ─── Seeded RNG ──────────────────────────────────────────────────────────────
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return (s >>> 0) / 4294967296;
  };
}
const rng = makeRng(0xDEADBEEF);

// ─── Platform generation ──────────────────────────────────────────────────────
function generatePlatforms(count) {
  const result = [];
  let cumulativeHeight = 0;

  for (let i = 0; i <= count; i++) {
    const isEven = i % 2 === 0;
    const band = isEven ? LEFT_BAND_X : RIGHT_BAND_X;
    const x = band[0] + rng() * (band[1] - band[0]);

    const wideChance = i < WIDE_GAP_START
      ? 0
      : Math.min(0.45, WIDE_GAP_FREQ + (i - WIDE_GAP_START) * 0.012);
    const isWide = rng() < wideChance && i >= WIDE_GAP_START;

    if (i > 0) cumulativeHeight += isWide ? WIDE_GAP : LEVEL_HEIGHT;
    const worldY = -cumulativeHeight;  // negative = above start
    const w = isWide ? PLATFORM_W_WIDE : PLATFORM_W_NORM;

    // Pest assignment
    let pest = null;
    let pickup = null;
    if (i >= 3) {
      const pestChance = Math.min(0.70, 0.25 + i * 0.025);
      if (rng() < pestChance) {
        const eligible = PEST_TYPES.filter(p => p.minPlat <= i);
        const pt = eligible[Math.floor(rng() * eligible.length)];
        const pestX = x + rng() * Math.max(0, w - pt.pw - 8) + 4;
        pest = { ...pt, x: pestX, alive: true, flashFrames: 0 };

        // Guarantee pickup on same platform if pest resists something
        if (pt.resists !== null) {
          const pickupX = x + rng() * Math.max(0, w - 10) + 2;
          pickup = { nozzle: pt.bonusNozzle, x: pickupX, collected: false };
        }
      }
    }

    // Random pickup chance even without a resistant pest
    if (!pickup && i >= 1 && rng() < 0.18) {
      const nozzleKeys = Object.keys(NOZZLES).filter(k => k !== 'foam');
      const n = nozzleKeys[Math.floor(rng() * nozzleKeys.length)];
      const pickupX = x + rng() * Math.max(0, w - 10) + 2;
      pickup = { nozzle: n, x: pickupX, collected: false };
    }

    result.push({ index: i, x, worldY, w, h: 8, isWide, pest, pickup, visited: false });
  }
  return result;
}

// ─── Kent object ─────────────────────────────────────────────────────────────
function makeKent() {
  const spawn = platforms[0];
  return {
    x: spawn.x + spawn.w / 2 - KENT_W / 2,
    worldY: spawn.worldY - KENT_H,
    vx: 0,
    vy: 0,
    onGround: false,
    facing: 1,
    wallContact: 0,
    lastWall: 0,
    jumpPressed: false,
    jumpHoldStart: 0,
    jumpApplied: false,
    platformIndex: 0,
    fastFall: false,
    standingOn: null,
    nozzle: 'foam',
    nozzleUses: Infinity,
  };
}

// ─── Input ───────────────────────────────────────────────────────────────────
const keys = {};
const justPressed = {};
const justReleased = {};

window.addEventListener('keydown', e => {
  if (!keys[e.code]) justPressed[e.code] = true;
  keys[e.code] = true;
  if (['Space','ArrowUp','ArrowDown'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', e => {
  keys[e.code] = false;
  justReleased[e.code] = true;
});

function isJumpKey(code)  { return code === 'Space' || code === 'KeyW' || code === 'ArrowUp'; }
function isLeftKey(code)  { return code === 'ArrowLeft' || code === 'KeyA'; }
function isRightKey(code) { return code === 'ArrowRight' || code === 'KeyD'; }
function isDownKey(code)  { return code === 'ArrowDown' || code === 'KeyS'; }
function isSprayKey(code) { return code === 'KeyF' || code === 'KeyZ' || code === 'KeyB'; }

function jumpJustPressed()  { return Object.keys(justPressed).some(isJumpKey); }
function jumpHeld()         { return Object.keys(keys).filter(k => keys[k]).some(isJumpKey); }
function jumpJustReleased() { return Object.keys(justReleased).some(isJumpKey); }
function movingLeft()       { return Object.keys(keys).filter(k => keys[k]).some(isLeftKey); }
function movingRight()      { return Object.keys(keys).filter(k => keys[k]).some(isRightKey); }
function downHeld()         { return Object.keys(keys).filter(k => keys[k]).some(isDownKey); }
function sprayHeld()        { return Object.keys(keys).filter(k => keys[k]).some(isSprayKey); }

// ─── Spray ───────────────────────────────────────────────────────────────────
function fireSpray() {
  sprayVisual = 8;
  if (kent.nozzle !== 'foam') {
    kent.nozzleUses--;
    if (kent.nozzleUses <= 0) {
      kent.nozzle = 'foam';
      kent.nozzleUses = Infinity;
    }
  }

  const p = kent.standingOn;
  if (!p || !p.pest || !p.pest.alive) return;

  const kentCX = kent.x + KENT_W / 2;
  const pestCX = p.pest.x + p.pest.pw / 2;
  const inFront = kent.facing > 0 ? pestCX > kent.x : pestCX < kent.x + KENT_W;
  if (!inFront) return;

  if (p.pest.resists === kent.nozzle) {
    p.pest.flashFrames = 10;
    return;
  }

  p.pest.alive = false;
  score += p.pest.pts;
  if (p.pest.bonusNozzle === kent.nozzle) score += p.pest.bonus;
}

// ─── Update goo ──────────────────────────────────────────────────────────────
function updateGoo() {
  goo.speed = GOO_BASE_SPEED + gameTick * 0.0001 + kent.platformIndex * 0.005;
  goo.worldY -= goo.speed;
  gameTick++;

  if (goo.worldY <= kent.worldY + KENT_H + 2) {
    gameState = 'DEAD';
    highScore = Math.max(highScore, score);
    Leaderboard.submit('KENT', score, kent.platformIndex);
  }
}

// ─── Update Kent ─────────────────────────────────────────────────────────────
function updateKent() {
  const k = kent;

  // ── Horizontal input ──
  const spd = k.onGround ? WALK_SPEED : AIR_SPEED;
  if (movingLeft()) {
    k.vx = -spd;
    k.facing = -1;
  } else if (movingRight()) {
    k.vx = spd;
    k.facing = 1;
  } else {
    k.vx *= k.onGround ? 0.6 : 0.92;
  }

  // ── Fast fall ──
  k.fastFall = !k.onGround && downHeld();

  // ── Jump initiation ──
  if (jumpJustPressed()) {
    if (k.onGround) {
      k.vy = -JUMP_MIN;
      k.onGround = false;
      k.standingOn = null;
      k.jumpPressed = true;
      k.jumpHoldStart = performance.now();
      k.jumpApplied = true;
      k.wallContact = 0;
    } else if (k.wallContact !== 0) {
      if (k.wallContact !== k.lastWall) {
        const kickDir = -k.wallContact;
        k.vx = kickDir * WALL_KICK_X;
        k.vy = -WALL_KICK_Y;
        k.lastWall = k.wallContact;
        k.wallContact = 0;
        k.jumpPressed = false;
        k.jumpApplied = true;
      }
    }
  }

  // ── Variable jump height ──
  if (k.jumpPressed && jumpHeld() && !k.onGround) {
    const elapsed = performance.now() - k.jumpHoldStart;
    if (elapsed < JUMP_HOLD_MS && k.vy < 0) {
      const t = Math.min(1, elapsed / JUMP_HOLD_MS);
      const target = -(JUMP_MIN + (JUMP_MAX - JUMP_MIN) * t);
      if (k.vy > target) k.vy = target;
    }
  }
  if (jumpJustReleased()) k.jumpPressed = false;

  // ── Gravity ──
  if (k.fastFall) {
    k.vy += GRAVITY * 2.5;
  } else if (k.wallContact !== 0 && k.vy > 0) {
    k.vy = Math.min(k.vy + GRAVITY, WALL_SLIDE_MAX);
  } else {
    k.vy += GRAVITY;
  }
  k.vy = Math.min(k.vy, MAX_FALL);

  // ── Move ──
  k.x += k.vx;
  k.worldY += k.vy;

  // ── Wall collision ──
  k.wallContact = 0;
  if (k.x <= WALL_LEFT_X + WALL_CONTACT) {
    k.x = WALL_LEFT_X + WALL_CONTACT;
    if (!k.onGround && k.vy > 0) k.wallContact = -1;
    if (k.vx < 0) k.vx = 0;
  }
  if (k.x + KENT_W >= WALL_RIGHT_X - WALL_CONTACT) {
    k.x = WALL_RIGHT_X - WALL_CONTACT - KENT_W;
    if (!k.onGround && k.vy > 0) k.wallContact = 1;
    if (k.vx > 0) k.vx = 0;
  }

  // ── Platform collision ──
  k.onGround = false;
  k.standingOn = null;
  for (const p of platforms) {
    const prevBottom = k.worldY + KENT_H - k.vy;
    const curBottom  = k.worldY + KENT_H;
    if (
      k.vy >= 0 &&
      prevBottom <= p.worldY + 1 &&
      curBottom >= p.worldY &&
      k.x + KENT_W > p.x &&
      k.x < p.x + p.w
    ) {
      k.worldY = p.worldY - KENT_H;
      k.vy = 0;
      k.onGround = true;
      k.standingOn = p;
      k.wallContact = 0;
      k.lastWall = 0;
      k.fastFall = false;

      if (!p.visited) {
        p.visited = true;
        score += 3;
      }
      if (p.index > k.platformIndex) k.platformIndex = p.index;

      // Pickup collection
      if (p.pickup && !p.pickup.collected) {
        const kcx = k.x + KENT_W / 2;
        const pcx = p.pickup.x + 5;
        if (Math.abs(kcx - pcx) < 18) {
          p.pickup.collected = true;
          k.nozzle = p.pickup.nozzle;
          k.nozzleUses = NOZZLE_USES;
        }
      }
      break;
    }
  }

  // ── Pickup collection while walking ──
  if (k.standingOn) {
    const p = k.standingOn;
    if (p.pickup && !p.pickup.collected) {
      const kcx = k.x + KENT_W / 2;
      const pcx = p.pickup.x + 5;
      if (Math.abs(kcx - pcx) < 18) {
        p.pickup.collected = true;
        k.nozzle = p.pickup.nozzle;
        k.nozzleUses = NOZZLE_USES;
      }
    }
  }

  // ── Spray ──
  if (sprayCooldown > 0) sprayCooldown--;
  if (sprayVisual > 0) sprayVisual--;

  if (sprayHeld() && sprayCooldown === 0) {
    sprayCooldown = SPRAY_COOLDOWN;
    fireSpray();
  }

  // ── Pest flash tick ──
  for (const p of platforms) {
    if (p.pest && p.pest.flashFrames > 0) p.pest.flashFrames--;
  }

  // ── Camera ──
  const targetCamY = k.worldY - H * 0.35;
  camera += (targetCamY - camera) * 0.12;
  camera = Math.max(camera, targetCamY - 80);
}

// ─── Draw helpers ─────────────────────────────────────────────────────────────
function toScreen(worldY) { return worldY - camera; }

function drawPipes() {
  ctx.fillStyle = '#1a2a1a';
  ctx.fillRect(0, 0, WALL_LEFT_X, H);
  ctx.fillStyle = '#2d4a2d';
  ctx.fillRect(WALL_LEFT_X - 3, 0, 3, H);
  ctx.fillStyle = '#1a2a1a';
  ctx.fillRect(WALL_RIGHT_X, 0, W - WALL_RIGHT_X, H);
  ctx.fillStyle = '#2d4a2d';
  ctx.fillRect(WALL_RIGHT_X, 0, 3, H);
}

function drawPlatform(p) {
  const sy = toScreen(p.worldY);
  if (sy > H + 20 || sy < -20) return;

  ctx.fillStyle = p.isWide ? '#2a4a6a' : '#1e3a1e';
  ctx.fillRect(p.x, sy, p.w, p.h);
  ctx.fillStyle = p.isWide ? '#4a8aaa' : '#3a8a3a';
  ctx.fillRect(p.x, sy, p.w, 2);

  // Draw pest
  if (p.pest && p.pest.alive) {
    const pestSY = sy - p.pest.ph;
    drawPest(p.pest, pestSY);
  }

  // Draw pickup
  if (p.pickup && !p.pickup.collected) {
    const col = NOZZLES[p.pickup.nozzle].color;
    const psy = sy - 8;
    ctx.fillStyle = col;
    ctx.fillRect(p.pickup.x, psy, 10, 6);
    ctx.fillStyle = '#ffffff44';
    ctx.fillRect(p.pickup.x + 1, psy + 1, 8, 2);
  }
}

function drawPest(pest, screenY) {
  if (pest.flashFrames > 0 && Math.floor(frameCount / 2) % 2 === 0) {
    ctx.fillStyle = '#ffffff';
  } else {
    ctx.fillStyle = pest.color;
  }
  ctx.fillRect(pest.x, screenY, pest.pw, pest.ph);

  if (pest.id === 'ant') {
    ctx.fillStyle = '#000';
    ctx.fillRect(pest.x + 1, screenY - 3, 1, 3);
    ctx.fillRect(pest.x + pest.pw - 2, screenY - 3, 1, 3);
  } else if (pest.id === 'roach') {
    ctx.fillStyle = '#3a2a0a';
    ctx.fillRect(pest.x + 2, screenY, 2, pest.ph);
  } else if (pest.id === 'fly') {
    ctx.fillStyle = '#cccccc';
    ctx.fillRect(pest.x - 3, screenY + 1, 4, 3);
    ctx.fillRect(pest.x + pest.pw - 1, screenY + 1, 4, 3);
  } else if (pest.id === 'spider') {
    ctx.fillStyle = '#555';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(pest.x - 4, screenY + i * 2 + 1, 4, 1);
      ctx.fillRect(pest.x + pest.pw, screenY + i * 2 + 1, 4, 1);
    }
  } else if (pest.id === 'wasp') {
    ctx.fillStyle = '#222';
    ctx.fillRect(pest.x + 3, screenY, pest.pw - 6, pest.ph);
    ctx.fillStyle = '#ffff00';
    ctx.fillRect(pest.x + 4, screenY + 2, pest.pw - 8, 3);
  } else if (pest.id === 'rat') {
    ctx.fillStyle = '#aaa';
    ctx.fillRect(pest.x + pest.pw, screenY + 3, 8, 3);
    ctx.fillRect(pest.x - 5, screenY, 6, 7);
  }
}

function drawKent() {
  const sx = kent.x;
  const sy = toScreen(kent.worldY);

  ctx.fillStyle = '#d4b483';
  ctx.fillRect(sx, sy + 8, KENT_W, KENT_H - 8);

  ctx.fillStyle = '#e8c89a';
  ctx.fillRect(sx + 2, sy, KENT_W - 4, 10);

  ctx.fillStyle = '#222';
  const eyeX = kent.facing > 0 ? sx + KENT_W - 6 : sx + 3;
  ctx.fillRect(eyeX, sy + 3, 2, 2);

  ctx.fillStyle = '#4a6a9a';
  ctx.fillRect(sx, sy + 12, KENT_W, KENT_H - 18);

  if (kent.wallContact !== 0) {
    ctx.fillStyle = 'rgba(255,200,100,0.35)';
    ctx.fillRect(sx, sy, KENT_W, KENT_H);
  }

  if (!kent.onGround) {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.ellipse(sx + KENT_W / 2, toScreen(kent.worldY + KENT_H + 4), KENT_W * 0.6, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Spray beam
  if (sprayVisual > 0) {
    const col = NOZZLES[kent.nozzle].color;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    const bx = kent.facing > 0 ? sx + KENT_W : sx;
    const ex = kent.facing > 0 ? WALL_RIGHT_X - 4 : WALL_LEFT_X + 4;
    const by = sy + KENT_H * 0.5;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(ex, by);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawGoo() {
  const gooSY = toScreen(goo.worldY);
  if (gooSY > H) return;

  const grad = ctx.createLinearGradient(0, gooSY, 0, H);
  grad.addColorStop(0, 'rgba(0,220,60,0.85)');
  grad.addColorStop(0.3, 'rgba(0,160,40,0.9)');
  grad.addColorStop(1, 'rgba(0,80,20,1)');
  ctx.fillStyle = grad;
  ctx.fillRect(WALL_LEFT_X, gooSY, WALL_RIGHT_X - WALL_LEFT_X, H - gooSY);

  // Bubbles
  ctx.fillStyle = 'rgba(100,255,100,0.5)';
  for (let b = 0; b < 6; b++) {
    const bx = WALL_LEFT_X + 20 + (b * 53 + frameCount * (b % 2 === 0 ? 0.7 : 0.4)) % (WALL_RIGHT_X - WALL_LEFT_X - 40);
    const by = gooSY + 4 + Math.sin(frameCount * 0.08 + b) * 3;
    const br = 3 + (b % 3);
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
  }

  // Surface ripple
  ctx.strokeStyle = 'rgba(150,255,150,0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = WALL_LEFT_X; x < WALL_RIGHT_X; x += 4) {
    const y = gooSY + Math.sin((x + frameCount * 2) * 0.08) * 2;
    x === WALL_LEFT_X ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawHUD() {
  ctx.font = 'bold 13px "Courier New", monospace';
  ctx.textBaseline = 'top';

  // Score
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`SCORE ${score}`, WALL_LEFT_X + 4, 6);

  // Platform reached
  ctx.fillStyle = '#aaaaaa';
  ctx.fillText(`LV ${kent.platformIndex}`, WALL_LEFT_X + 4, 22);

  // Nozzle (centered)
  const nozzleInfo = NOZZLES[kent.nozzle];
  ctx.fillStyle = nozzleInfo.color;
  const usesStr = kent.nozzleUses === Infinity ? '∞' : `${kent.nozzleUses}`;
  const nozzleStr = `${nozzleInfo.name} x${usesStr}`;
  ctx.textAlign = 'center';
  ctx.fillText(nozzleStr, W / 2, 6);
  ctx.textAlign = 'left';

  // Goo warning
  const gooScreenY = toScreen(goo.worldY);
  if (gooScreenY < H - 60) {
    const pulse = 0.6 + 0.4 * Math.sin(frameCount * 0.2);
    ctx.fillStyle = `rgba(0,255,80,${pulse})`;
    ctx.font = 'bold 11px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('! GOO RISING !', W / 2, H - 20);
    ctx.textAlign = 'left';
  }

  // Debug
  const dbg = document.getElementById('debug');
  if (dbg) {
    dbg.textContent =
      `vy:${kent.vy.toFixed(1)} vx:${kent.vx.toFixed(1)} ` +
      `gnd:${kent.onGround?'Y':'N'} wall:${kent.wallContact} ` +
      `nozzle:${kent.nozzle} gooY:${Math.round(goo.worldY)}`;
  }
}

function drawGameOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(WALL_LEFT_X, 0, WALL_RIGHT_X - WALL_LEFT_X, H);

  ctx.font = 'bold 22px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ff4444';
  ctx.fillText('EXTERMINATED', W / 2, H / 2 - 60);

  ctx.font = '14px "Courier New", monospace';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`SCORE: ${score}`, W / 2, H / 2 - 20);
  ctx.fillText(`PLATFORM: ${kent.platformIndex}`, W / 2, H / 2);
  ctx.fillStyle = '#ffdd44';
  ctx.fillText(`BEST: ${highScore}`, W / 2, H / 2 + 22);

  ctx.fillStyle = '#aaaaaa';
  ctx.font = '11px "Courier New", monospace';
  ctx.fillText('PRESS ANY KEY TO RETRY', W / 2, H / 2 + 54);
  ctx.textAlign = 'left';
}

// ─── Game reset ───────────────────────────────────────────────────────────────
function resetGame() {
  platforms = generatePlatforms(80);
  kent = makeKent();
  goo = { worldY: GOO_START_Y, speed: GOO_BASE_SPEED };
  score = 0;
  gameTick = 0;
  sprayCooldown = 0;
  sprayVisual = 0;
  camera = platforms[0].worldY - H * 0.65;
  gameState = 'PLAYING';
}

// ─── Main loop ────────────────────────────────────────────────────────────────
function frame() {
  frameCount++;

  if (gameState === 'DEAD' && Object.keys(justPressed).length > 0) {
    resetGame();
  }

  for (const k in justPressed) delete justPressed[k];
  for (const k in justReleased) delete justReleased[k];

  if (gameState === 'PLAYING') {
    updateKent();
    updateGoo();
  }

  // Draw
  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(0, 0, W, H);

  drawPipes();
  for (const p of platforms) drawPlatform(p);
  drawGoo();
  drawKent();
  drawHUD();

  if (gameState === 'DEAD') drawGameOver();

  requestAnimationFrame(frame);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  resetGame();
  requestAnimationFrame(frame);
}

init();
