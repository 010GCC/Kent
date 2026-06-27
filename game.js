// KENT // EXTERMINATOR — Physics test rig (v6 / zigzag-jump model)
// Pests, goo, nozzles, and scoring are stubbed for later integration.

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const W = canvas.width;   // 360
const H = canvas.height;  // 540

// ─── Tuning constants ────────────────────────────────────────────────────────
const GRAVITY        = 0.55;   // px/frame²
const JUMP_MIN       = 8.5;    // vy on tap
const JUMP_MAX       = 11.0;   // vy when held to peak
const JUMP_HOLD_MS   = 160;    // ms window to get full charge
const WALK_SPEED     = 2.8;    // px/frame ground
const AIR_SPEED      = 2.6;    // px/frame air (slight commitment)
const MAX_FALL       = 14;     // terminal velocity
const WALL_SLIDE_MAX = 1.5;    // capped fall speed when sliding on wall
const WALL_KICK_X    = 4.2;    // horizontal impulse away from wall
const WALL_KICK_Y    = 8.2;    // vertical impulse from wall jump

const LEVEL_HEIGHT   = 58;     // normal vertical gap between platforms
const WIDE_GAP       = 90;     // wide-gap height (needs wall-jump or max held)
const WIDE_GAP_START = 5;      // first wide gap appears at platform index
const WIDE_GAP_FREQ  = 0.18;   // chance of wide gap per platform (scales with height)

const WALL_LEFT_X    = 18;     // left pipe wall right edge
const WALL_RIGHT_X   = W - 18; // right pipe wall left edge
const WALL_CONTACT   = 6;      // px threshold for wall contact

const PLATFORM_W_NORM = 72;    // normal platform width
const PLATFORM_W_WIDE = 88;    // wider platform at wide gaps (easier landing)

const LEFT_BAND_X    = [WALL_LEFT_X + 12, W / 2 - 24];   // x-range for even platforms
const RIGHT_BAND_X   = [W / 2 + 24, WALL_RIGHT_X - 84];  // x-range for odd platforms

const KENT_W = 18;
const KENT_H = 26;

// ─── World state ─────────────────────────────────────────────────────────────
let platforms = [];
let kent;
let camera;       // world-y at top of viewport
let maxPlatformReached = 0;
let frameCount = 0;

// ─── Seeded RNG (for reproducible platform layouts) ──────────────────────────
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
function generatePlatform(index) {
  const isEven = index % 2 === 0;
  const band = isEven ? LEFT_BAND_X : RIGHT_BAND_X;
  const x = band[0] + rng() * (band[1] - band[0]);

  // Decide if this gap is wide
  const wideChance = index < WIDE_GAP_START
    ? 0
    : Math.min(0.45, WIDE_GAP_FREQ + (index - WIDE_GAP_START) * 0.012);
  const isWide = rng() < wideChance && index >= WIDE_GAP_START;

  const height = index * LEVEL_HEIGHT + (isWide ? WIDE_GAP : 0);
  const w = isWide ? PLATFORM_W_WIDE : PLATFORM_W_NORM;

  return { index, x, worldY: height, w, h: 8, isWide };
}

function initPlatforms() {
  platforms = [];
  // Generate enough platforms to fill viewport + a buffer above
  for (let i = 0; i <= 60; i++) {
    platforms.push(generatePlatform(i));
  }
}

// ─── Kent object ─────────────────────────────────────────────────────────────
function makeKent() {
  const spawn = platforms[0];
  return {
    x: spawn.x + spawn.w / 2 - KENT_W / 2,
    worldY: spawn.worldY - KENT_H,    // bottom of Kent sits on platform top
    vx: 0,
    vy: 0,
    onGround: false,
    facing: 1,           // 1=right, -1=left
    wallContact: 0,      // -1=left wall, 0=none, 1=right wall
    lastWall: 0,         // prevents double-jump off same wall
    jumpPressed: false,
    jumpHoldStart: 0,    // timestamp when jump pressed
    jumpApplied: false,  // whether we already applied the impulse this press
    platformIndex: 0,    // highest platform Kent has fully landed on
    fastFall: false,
  };
}

// ─── Input ───────────────────────────────────────────────────────────────────
const keys = {};
const justPressed = {};
const justReleased = {};

window.addEventListener('keydown', e => {
  if (!keys[e.code]) justPressed[e.code] = true;
  keys[e.code] = true;
  // suppress scroll
  if (['Space','ArrowUp','ArrowDown'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', e => {
  keys[e.code] = false;
  justReleased[e.code] = true;
});

function isJumpKey(code) { return code === 'Space' || code === 'KeyW' || code === 'ArrowUp'; }
function isLeftKey(code)  { return code === 'ArrowLeft' || code === 'KeyA'; }
function isRightKey(code) { return code === 'ArrowRight' || code === 'KeyD'; }
function isDownKey(code)  { return code === 'ArrowDown' || code === 'KeyS'; }

function jumpJustPressed()   { return Object.keys(justPressed).some(isJumpKey); }
function jumpHeld()          { return Object.keys(keys).filter(k => keys[k]).some(isJumpKey); }
function jumpJustReleased()  { return Object.keys(justReleased).some(isJumpKey); }
function movingLeft()        { return Object.keys(keys).filter(k => keys[k]).some(isLeftKey); }
function movingRight()       { return Object.keys(keys).filter(k => keys[k]).some(isRightKey); }
function downHeld()          { return Object.keys(keys).filter(k => keys[k]).some(isDownKey); }

// ─── Physics & collision ──────────────────────────────────────────────────────
function getPlatformRect(p) {
  return { x: p.x, y: p.worldY, w: p.w, h: p.h };
}

function aabbOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

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
    k.vx *= k.onGround ? 0.6 : 0.92; // friction on ground, float in air
  }

  // ── Fast fall ──
  k.fastFall = !k.onGround && downHeld();

  // ── Jump initiation ──
  if (jumpJustPressed()) {
    if (k.onGround) {
      // Ground jump
      k.vy = -JUMP_MIN;
      k.onGround = false;
      k.jumpPressed = true;
      k.jumpHoldStart = performance.now();
      k.jumpApplied = true;
      k.wallContact = 0;
    } else if (k.wallContact !== 0) {
      // Wall jump — only if it's a different wall than last time
      if (k.wallContact !== k.lastWall) {
        const kickDir = -k.wallContact; // push away from wall
        k.vx = kickDir * WALL_KICK_X;
        k.vy = -WALL_KICK_Y;
        k.lastWall = k.wallContact;
        k.wallContact = 0;
        k.jumpPressed = false;
        k.jumpApplied = true;
      }
    }
  }

  // ── Variable jump height: keep adding upward while held ──
  if (k.jumpPressed && jumpHeld() && !k.onGround) {
    const elapsed = performance.now() - k.jumpHoldStart;
    if (elapsed < JUMP_HOLD_MS && k.vy < 0) {
      const t = Math.min(1, elapsed / JUMP_HOLD_MS);
      const target = -(JUMP_MIN + (JUMP_MAX - JUMP_MIN) * t);
      if (k.vy > target) k.vy = target; // keep boosting toward max
    }
  }
  if (jumpJustReleased()) {
    k.jumpPressed = false;
  }

  // ── Gravity ──
  if (k.fastFall) {
    k.vy += GRAVITY * 2.5;
  } else if (k.wallContact !== 0 && k.vy > 0) {
    // Wall slide: cap fall speed
    k.vy = Math.min(k.vy + GRAVITY, WALL_SLIDE_MAX);
  } else {
    k.vy += GRAVITY;
  }
  k.vy = Math.min(k.vy, MAX_FALL);

  // ── Move ──
  k.x += k.vx;
  k.worldY += k.vy;

  // ── Wall collision (pipe walls) ──
  k.wallContact = 0;
  if (k.x <= WALL_LEFT_X + WALL_CONTACT) {
    k.x = WALL_LEFT_X + WALL_CONTACT;
    if (!k.onGround && k.vy > 0) {
      k.wallContact = -1; // on left wall
    }
    if (k.vx < 0) k.vx = 0;
  }
  if (k.x + KENT_W >= WALL_RIGHT_X - WALL_CONTACT) {
    k.x = WALL_RIGHT_X - WALL_CONTACT - KENT_W;
    if (!k.onGround && k.vy > 0) {
      k.wallContact = 1; // on right wall
    }
    if (k.vx > 0) k.vx = 0;
  }

  // ── Platform collision (top only, one-way) ──
  k.onGround = false;
  for (const p of platforms) {
    const pr = getPlatformRect(p);
    const prevBottom = k.worldY + KENT_H - k.vy; // bottom before this frame's move
    const curBottom = k.worldY + KENT_H;
    // Only snap to top if Kent was above and now crosses it, moving downward
    if (
      k.vy >= 0 &&
      prevBottom <= pr.y + 1 &&
      curBottom >= pr.y &&
      k.x + KENT_W > pr.x &&
      k.x < pr.x + pr.w
    ) {
      k.worldY = pr.y - KENT_H;
      k.vy = 0;
      k.onGround = true;
      k.wallContact = 0;
      k.lastWall = 0; // reset wall-jump memory on landing
      k.fastFall = false;
      if (p.index > k.platformIndex) {
        k.platformIndex = p.index;
        maxPlatformReached = Math.max(maxPlatformReached, p.index);
      }
      break;
    }
  }

  // ── Camera: keep Kent in upper third ──
  const targetCamY = k.worldY - H * 0.35;
  // Smooth follow up (camera rises freely), but don't scroll down faster than Kent falls
  camera += (targetCamY - camera) * 0.12;
  camera = Math.max(camera, targetCamY - 80); // never lag too far below
}

// ─── Draw ─────────────────────────────────────────────────────────────────────
function toScreen(worldY) {
  return worldY - camera;
}

function drawPipes() {
  // Left pipe
  ctx.fillStyle = '#1a2a1a';
  ctx.fillRect(0, 0, WALL_LEFT_X, H);
  ctx.fillStyle = '#2d4a2d';
  ctx.fillRect(WALL_LEFT_X - 3, 0, 3, H);
  // Right pipe
  ctx.fillStyle = '#1a2a1a';
  ctx.fillRect(WALL_RIGHT_X, 0, W - WALL_RIGHT_X, H);
  ctx.fillStyle = '#2d4a2d';
  ctx.fillRect(WALL_RIGHT_X, 0, 3, H);
}

function drawPlatform(p) {
  const sy = toScreen(p.worldY);
  if (sy > H + 20 || sy < -20) return;

  // Color wide-gap platforms slightly differently
  ctx.fillStyle = p.isWide ? '#2a4a6a' : '#1e3a1e';
  ctx.fillRect(p.x, sy, p.w, p.h);
  // Highlight edge
  ctx.fillStyle = p.isWide ? '#4a8aaa' : '#3a8a3a';
  ctx.fillRect(p.x, sy, p.w, 2);
}

function drawKent() {
  const sx = kent.x;
  const sy = toScreen(kent.worldY);

  // Body
  ctx.fillStyle = '#d4b483';
  ctx.fillRect(sx, sy + 8, KENT_W, KENT_H - 8);

  // Head
  ctx.fillStyle = '#e8c89a';
  ctx.fillRect(sx + 2, sy, KENT_W - 4, 10);

  // Eyes
  ctx.fillStyle = '#222';
  const eyeX = kent.facing > 0 ? sx + KENT_W - 6 : sx + 3;
  ctx.fillRect(eyeX, sy + 3, 2, 2);

  // Overalls / shirt
  ctx.fillStyle = '#4a6a9a';
  ctx.fillRect(sx, sy + 12, KENT_W, KENT_H - 18);

  // Wall-slide visual
  if (kent.wallContact !== 0) {
    ctx.fillStyle = 'rgba(255,200,100,0.35)';
    ctx.fillRect(sx, sy, KENT_W, KENT_H);
  }

  // Jump shadow (faint)
  if (!kent.onGround) {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.ellipse(sx + KENT_W/2, toScreen(kent.worldY + KENT_H + 4), KENT_W * 0.6, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHUD() {
  const height = Math.max(0, Math.round(kent.worldY * -1 / 10));
  document.getElementById('hud-height').textContent = height;
  document.getElementById('hud-plat').textContent = kent.platformIndex;
  const wjState = kent.wallContact !== 0 ? 'CONTACT' : kent.lastWall !== 0 ? 'USED' : 'READY';
  document.getElementById('hud-wj').textContent = wjState;
  document.getElementById('debug').textContent =
    `vy:${kent.vy.toFixed(1)} vx:${kent.vx.toFixed(1)} ` +
    `gnd:${kent.onGround?'Y':'N'} wall:${kent.wallContact} lastWall:${kent.lastWall} ` +
    `cam:${Math.round(camera)}`;
}

// ─── Main loop ────────────────────────────────────────────────────────────────
function frame() {
  frameCount++;

  // Clear input events from previous frame
  for (const k in justPressed) delete justPressed[k];
  for (const k in justReleased) delete justReleased[k];

  updateKent();

  // ── Draw ──
  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(0, 0, W, H);

  drawPipes();

  for (const p of platforms) drawPlatform(p);
  drawKent();

  // Ground level indicator (faint)
  const groundY = toScreen(0);
  if (groundY > 0 && groundY < H) {
    ctx.fillStyle = '#1a1a2a';
    ctx.fillRect(WALL_LEFT_X, groundY, WALL_RIGHT_X - WALL_LEFT_X, H - groundY);
    ctx.fillStyle = '#2a2a4a';
    ctx.fillRect(WALL_LEFT_X, groundY, WALL_RIGHT_X - WALL_LEFT_X, 2);
  }

  drawHUD();

  requestAnimationFrame(frame);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  initPlatforms();
  kent = makeKent();
  camera = -H * 0.35;
  requestAnimationFrame(frame);
}

init();
