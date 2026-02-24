<!-- app/pages/index.vue -->
<!-- app/pages/index.vue -->
<script setup lang="ts">
useHead({ title: 'Triangle Dominion' })

/* =========================================================
   AUDIO (SFX toggle + BGM toggle)
   ✅ Requires updated useAudioFx() that has:
      - sfxEnabled, bgmEnabled
      - setSfxEnabled(), setBgmEnabled()
========================================================= */
const audio = useAudioFx()

onMounted(() => {
  audio.initAudio()
  void audio.playBgm('bgm_menu') // will start after first user gesture if autoplay blocked
})

function toggleSfx() {
  audio.unlockAudio()
  const next = !audio.sfxEnabled.value
  audio.setSfxEnabled(next)
  if (next) audio.playSfx('ui_click')
}

function toggleBgm() {
  audio.unlockAudio()
  const next = !audio.bgmEnabled.value
  audio.setBgmEnabled(next)
  // click feedback only if SFX is enabled
  if (audio.sfxEnabled.value) audio.playSfx('ui_click')
}

/* =========================================================
   TYPES
========================================================= */
type Dot = { id: number; x: number; y: number; neighbors: number[] }

type BoardPreset = {
  id: string
  name: string
  tag: 'Shape'
  description: string
}

/* =========================================================
   ROUTING / UI STATE
========================================================= */
const router = useRouter()
const step = ref<'menu' | 'board'>('menu')
const showHow = ref(false)

function goPlay(boardId: string) {
  audio.stopBgm(false)
  router.push({ path: '/play', query: { board: boardId, autostart: '1' } })
}

/** UX: ESC to close modal/back */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (showHow.value) {
      audio.playSfx('ui_modal_close')
      showHow.value = false
    } else if (step.value === 'board') {
      audio.playSfx('ui_back')
      step.value = 'menu'
    }
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function openHow() {
  audio.unlockAudio()
  audio.playSfx('ui_modal_open')
  showHow.value = true
}
function closeHow() {
  audio.playSfx('ui_modal_close')
  showHow.value = false
}
function toBoardSelect() {
  audio.unlockAudio()
  audio.playSfx('ui_click')
  step.value = 'board'
}
function backToMenu() {
  audio.playSfx('ui_back')
  step.value = 'menu'
}

/* =========================================================
   EXACT BOARD GENERATION (SAME LOGIC AS /play)
========================================================= */
function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

function makeTriField(opts?: { rows?: number; cols?: number; spacing?: number; margin?: number }) {
  const rows = opts?.rows ?? 12
  const cols = opts?.cols ?? 14
  const s = opts?.spacing ?? 54
  const m = opts?.margin ?? 84

  const rowDy = Math.sin(Math.PI / 3) * s
  const idx = (r: number, c: number) => r * cols + c

  const dots: { id: number; x: number; y: number; r: number; c: number; neighbors: number[] }[] = []
  const neighborSet = new Map<number, Set<number>>()
  const add = (a: number, b: number) => {
    if (a === b) return
    if (!neighborSet.get(a)) neighborSet.set(a, new Set())
    neighborSet.get(a)!.add(b)
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = idx(r, c)
      const x = m + c * s + (r % 2 ? s / 2 : 0)
      const y = m + r * rowDy
      dots.push({ id, x, y, r, c, neighbors: [] })
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = idx(r, c)

      if (c - 1 >= 0) add(a, idx(r, c - 1))
      if (c + 1 < cols) add(a, idx(r, c + 1))

      if (r - 1 >= 0) {
        if (r % 2 === 0) {
          if (c - 1 >= 0) add(a, idx(r - 1, c - 1))
          add(a, idx(r - 1, c))
        } else {
          add(a, idx(r - 1, c))
          if (c + 1 < cols) add(a, idx(r - 1, c + 1))
        }
      }

      if (r + 1 < rows) {
        if (r % 2 === 0) {
          if (c - 1 >= 0) add(a, idx(r + 1, c - 1))
          add(a, idx(r + 1, c))
        } else {
          add(a, idx(r + 1, c))
          if (c + 1 < cols) add(a, idx(r + 1, c + 1))
        }
      }
    }
  }

  const full = dots.map((d) => ({
    id: d.id,
    x: d.x,
    y: d.y,
    neighbors: Array.from(neighborSet.get(d.id) ?? []).sort((a, b) => a - b),
    r: d.r,
    c: d.c
  }))

  const maxX = Math.max(...full.map((d) => d.x)) + m
  const maxY = Math.max(...full.map((d) => d.y)) + m
  return { dots: full, width: maxX, height: maxY, rows, cols, spacing: s, margin: m }
}

type RawFieldDot = ReturnType<typeof makeTriField>['dots'][number]

function remapFilteredBoard(field: ReturnType<typeof makeTriField>, keep: (d: RawFieldDot) => boolean) {
  const kept = field.dots.filter(keep)
  const idMap = new Map<number, number>()
  kept.forEach((d, i) => idMap.set(d.id, i))

  const dots: Dot[] = kept.map((d) => {
    const nid: number[] = []
    for (const oldN of d.neighbors) {
      const nn = idMap.get(oldN)
      if (nn != null) nid.push(nn)
    }
    return { id: idMap.get(d.id)!, x: d.x, y: d.y, neighbors: Array.from(new Set(nid)).sort((a, b) => a - b) }
  })

  const minX = Math.min(...dots.map((d) => d.x))
  const minY = Math.min(...dots.map((d) => d.y))
  const maxX = Math.max(...dots.map((d) => d.x))
  const maxY = Math.max(...dots.map((d) => d.y))

  const pad = 90
  const w = maxX - minX + pad * 2
  const h = maxY - minY + pad * 2

  for (const d of dots) {
    d.x = d.x - minX + pad
    d.y = d.y - minY + pad
  }

  const pruned: Dot[] = dots.filter((d) => d.neighbors.length > 0)
  if (pruned.length !== dots.length) {
    const map2 = new Map<number, number>()
    pruned.forEach((d, i) => map2.set(d.id, i))
    const rebuilt: Dot[] = pruned.map((d) => ({
      id: map2.get(d.id)!,
      x: d.x,
      y: d.y,
      neighbors: d.neighbors.map((n) => map2.get(n)!).filter((n) => n != null).sort((a, b) => a - b)
    }))
    return { dots: rebuilt, width: w, height: h }
  }

  return { dots, width: w, height: h }
}

function polygonMask(field: ReturnType<typeof makeTriField>, sides: number, radiusScale = 0.84, rotateRad = -Math.PI / 2) {
  const dots = field.dots
  const cx = (Math.min(...dots.map((d) => d.x)) + Math.max(...dots.map((d) => d.x))) / 2
  const cy = (Math.min(...dots.map((d) => d.y)) + Math.max(...dots.map((d) => d.y))) / 2
  const R = Math.min(field.width, field.height) * 0.35 * radiusScale

  const verts: { x: number; y: number }[] = []
  for (let i = 0; i < sides; i++) {
    const a = rotateRad + (i * Math.PI * 2) / sides
    verts.push({ x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R })
  }

  const inside = (px: number, py: number) => {
    let ins = false
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
      const xi = verts[i].x,
        yi = verts[i].y
      const xj = verts[j].x,
        yj = verts[j].y
      const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi
      if (intersect) ins = !ins
    }
    return ins
  }

  return remapFilteredBoard(field, (d) => inside(d.x, d.y))
}

/* presets */
function presetCircle() {
  const field = makeTriField({ rows: 13, cols: 15, spacing: 52, margin: 86 })
  const dots = field.dots
  const cx = (Math.min(...dots.map((d) => d.x)) + Math.max(...dots.map((d) => d.x))) / 2
  const cy = (Math.min(...dots.map((d) => d.y)) + Math.max(...dots.map((d) => d.y))) / 2
  const R = Math.min(field.width, field.height) * 0.33
  return remapFilteredBoard(field, (d) => Math.sqrt(dist2(d.x, d.y, cx, cy)) < R)
}
function presetTriangle() {
  const field = makeTriField({ rows: 12, cols: 14, spacing: 54, margin: 86 })
  return polygonMask(field, 3, 0.95, -Math.PI / 2)
}
function presetSquare() {
  const field = makeTriField({ rows: 12, cols: 12, spacing: 54, margin: 86 })
  return polygonMask(field, 4, 0.9, Math.PI / 4)
}
function presetRectangle() {
  const field = makeTriField({ rows: 10, cols: 16, spacing: 52, margin: 86 })
  const dots = field.dots
  const cx = (Math.min(...dots.map((d) => d.x)) + Math.max(...dots.map((d) => d.x))) / 2
  const cy = (Math.min(...dots.map((d) => d.y)) + Math.max(...dots.map((d) => d.y))) / 2
  const w = field.width * 0.34
  const h = field.height * 0.22
  return remapFilteredBoard(field, (d) => Math.abs(d.x - cx) < w && Math.abs(d.y - cy) < h)
}
function presetPentagon() {
  const field = makeTriField({ rows: 13, cols: 13, spacing: 52, margin: 86 })
  return polygonMask(field, 5, 0.88, -Math.PI / 2)
}
function presetHexagon() {
  const field = makeTriField({ rows: 13, cols: 13, spacing: 52, margin: 86 })
  return polygonMask(field, 6, 0.88, Math.PI / 6)
}

const BOARD_PRESETS: BoardPreset[] = [
  { id: 'circle', name: 'Bubble Arena', tag: 'Shape', description: 'Round and bouncy. Easy to read, fun to combo.' },
  { id: 'triangle', name: 'Tri Peak', tag: 'Shape', description: 'Sharp corners, quick fights, fast endings.' },
  { id: 'square', name: 'Pixel Square', tag: 'Shape', description: 'Classic grid-ish feel, balanced edges.' },
  { id: 'rectangle', name: 'Neon Strip', tag: 'Shape', description: 'Long arena—make chain captures!' },
  { id: 'pentagon', name: 'Pentagon Park', tag: 'Shape', description: 'Weird angles = playful tactics.' },
  { id: 'hexagon', name: 'Hex Hive', tag: 'Shape', description: 'Lots of options, high triangle potential.' }
]

function buildBoardById(id: string) {
  if (id === 'circle') return presetCircle()
  if (id === 'triangle') return presetTriangle()
  if (id === 'square') return presetSquare()
  if (id === 'rectangle') return presetRectangle()
  if (id === 'pentagon') return presetPentagon()
  return presetHexagon()
}

/* previews */
type Preview = { dots: Dot[]; width: number; height: number; edges: Array<{ a: number; b: number; key: string }> }
function makePreviewEdgeKey(a: number, b: number) {
  const x = Math.min(a, b)
  const y = Math.max(a, b)
  return `${x}_${y}`
}
function previewEdges(dots: Dot[]) {
  const seen = new Set<string>()
  const edges: Array<{ a: number; b: number; key: string }> = []
  for (const d of dots) {
    for (const n of d.neighbors) {
      const key = makePreviewEdgeKey(d.id, n)
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ a: Math.min(d.id, n), b: Math.max(d.id, n), key })
    }
  }
  return edges
}

const previews = computed<Record<string, Preview>>(() => {
  const out: Record<string, Preview> = {}
  for (const p of BOARD_PRESETS) {
    const b = buildBoardById(p.id)
    out[p.id] = { ...b, edges: previewEdges(b.dots) }
  }
  return out
})
</script>

<template>
  <div class="wrap" @pointerdown="audio.unlockAudio()">
    <!-- background -->
    <div class="bgEnergy">
      <div class="bgAurora a1"></div>
      <div class="bgAurora a2"></div>
      <div class="bgAurora a3"></div>
      <div class="bgGrid"></div>
      <div class="bgSparks"></div>
    </div>

    <!-- MENU -->
    <div v-if="step === 'menu'" class="panel neonCard enter">
      <div class="hero">
        <div class="brand">
          <div class="logoPulse">▲</div>
          <div>
            <div class="title neonText">Triangle Dominion</div>
            <div class="subtitle">Dice-driven line tactics. Claim triangles. Rule the board.</div>
          </div>
        </div>

        <div class="legacyMenu neonCard">
          <div class="legacyTitle neonText">Legacy Menu</div>

          <button class="btn primary neonBtn big" @click="toBoardSelect">
            <span class="zap">▶</span> Play
          </button>

          <button class="btn ghost neonBtn big" @click="openHow">
            <span class="zap">?</span> How to Play
          </button>

          <div class="tinyNote">Tip: Choose a board by clicking it. The match starts instantly.</div>

          <!-- ✅ SFX toggle -->
          <button class="btn ghost neonBtn" style="margin-top: 6px;" @click="toggleSfx">
            {{ audio.sfxEnabled.value ? '🔊 SFX: On' : '🔇 SFX: Off' }}
          </button>

          <!-- ✅ BGM toggle -->
          <button class="btn ghost neonBtn" style="margin-top: 6px;" @click="toggleBgm">
            {{ audio.bgmEnabled.value ? '🎵 BGM: On' : '🚫🎵 BGM: Off' }}
          </button>
        </div>
      </div>

      <div class="footerRow">
        <div class="pill neonPill">
          <span class="dot" style="background:#00F0FF; box-shadow: 0 0 18px #00F0FF;"></span>
          <b>vs AI</b>
          <span class="muted">— clean geometry, fast turns</span>
        </div>
      </div>
    </div>

    <!-- BOARD SELECT -->
    <div v-else class="panel neonCard enter">
      <div class="topRow">
        <div>
          <div class="title neonText">Pick a Board</div>
          <div class="subtitle">Click any board preview to start instantly.</div>
        </div>

        <div class="topActions">
          <button class="btn ghost neonBtn" @click="openHow">How to Play</button>
          <button class="btn ghost neonBtn" @click="backToMenu">Back</button>

          <!-- small toggles in header -->
          <button class="btn ghost neonBtn" @click="toggleSfx">
            {{ audio.sfxEnabled.value ? '🔊' : '🔇' }}
          </button>
          <button class="btn ghost neonBtn" @click="toggleBgm">
            {{ audio.bgmEnabled.value ? '🎵' : '🚫🎵' }}
          </button>
        </div>
      </div>

      <div class="boardGrid">
        <button
          v-for="p in BOARD_PRESETS"
          :key="p.id"
          class="boardCard"
          @mouseenter="audio.playSfx('ui_hover', 0.55)"
          @click="audio.unlockAudio(); audio.playSfx('ui_click'); goPlay(p.id)"
          :title="`Play: ${p.name}`"
        >
          <div class="cardHead">
            <div class="cardName">{{ p.name }}</div>
            <div class="cardTag">{{ p.tag }}</div>
          </div>
          <div class="cardDesc">{{ p.description }}</div>

          <div class="miniBoard">
            <div class="miniGlow"></div>

            <svg
              v-if="previews[p.id]"
              class="miniSvg"
              :viewBox="`0 0 ${previews[p.id].width} ${previews[p.id].height}`"
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
            >
              <g opacity="0.20">
                <line
                  v-for="e in previews[p.id].edges"
                  :key="`pv-${p.id}-${e.key}`"
                  :x1="previews[p.id].dots[e.a].x"
                  :y1="previews[p.id].dots[e.a].y"
                  :x2="previews[p.id].dots[e.b].x"
                  :y2="previews[p.id].dots[e.b].y"
                  class="pvEdge"
                />
              </g>

              <g>
                <circle v-for="d in previews[p.id].dots" :key="`pvd-${p.id}-${d.id}`" :cx="d.x" :cy="d.y" r="7.2" class="pvDot" />
              </g>
            </svg>

            <div class="tapHint">
              <span class="tapDot"></span>
              <b>Click to Play</b>
            </div>
          </div>
        </button>
      </div>

      <div class="tinyNote">
        Opens <b>/play</b> with <code>?board=&lt;id&gt;&amp;autostart=1</code>.
      </div>
    </div>

    <!-- HOW TO PLAY MODAL -->
    <div v-if="showHow" class="modal" @click.self="closeHow">
      <div class="modalCard neonCard pop">
        <div class="modalTitle neonText">How to Play</div>

        <div class="howGrid">
          <div class="howStep">
            <div class="howNum">1</div>
            <div>
              <div class="howHead">Roll the Dice</div>
              <div class="howText">You roll a D6. The result is how many edges you must draw this turn.</div>
            </div>
          </div>

          <div class="howStep">
            <div class="howNum">2</div>
            <div>
              <div class="howHead">Draw Exactly N Edges</div>
              <div class="howText">Click a dot → neighbors glow → click a neighbor to draw a line. No crossing allowed.</div>
            </div>
          </div>

          <div class="howStep">
            <div class="howNum">3</div>
            <div>
              <div class="howHead">Claim Triangles Instantly</div>
              <div class="howText">When the 3 edges of a triangle exist, it’s claimed immediately and you score +1.</div>
            </div>
          </div>

          <div class="howStep">
            <div class="howNum">4</div>
            <div>
              <div class="howHead">Win Condition</div>
              <div class="howText">Game ends when no legal moves remain. Most triangles wins.</div>
            </div>
          </div>
        </div>

        <div class="modalBtns">
          <button class="btn primary neonBtn" @click="closeHow"><span class="zap">✓</span> Got it</button>
          <button class="btn ghost neonBtn" @click="closeHow">Close</button>
        </div>

        <div class="tinyNote" style="margin-top:10px; opacity:.8;">
          Shortcut: press <b>ESC</b> to close this window.
        </div>
      </div>
    </div>
  </div>
</template>

<style>
*,
html { box-sizing: border-box; margin: 0; padding: 0; }

.wrap{
  min-height: 100vh;
  color: #fff;
  padding: 16px;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  position: relative;
  overflow: hidden;
  background: #02030a;
}

/* Background */
.bgEnergy{ position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden; }
.bgAurora{ position: absolute; inset: -20%; filter: blur(26px); opacity: 0.8; mix-blend-mode: screen; transform: translateZ(0); }
.bgAurora.a1{
  background:
    radial-gradient(900px 620px at 20% 18%, rgba(0,240,255,0.22), transparent 62%),
    radial-gradient(980px 650px at 82% 62%, rgba(255,61,166,0.18), transparent 64%),
    radial-gradient(700px 520px at 55% 10%, rgba(120,90,255,0.14), transparent 60%);
  animation: auroraDrift1 8.5s ease-in-out infinite alternate;
}
.bgAurora.a2{
  background:
    radial-gradient(900px 620px at 80% 22%, rgba(120,255,70,0.10), transparent 62%),
    radial-gradient(900px 620px at 45% 78%, rgba(0,240,255,0.12), transparent 62%),
    radial-gradient(700px 520px at 16% 70%, rgba(255,61,166,0.10), transparent 60%);
  animation: auroraDrift2 10.5s ease-in-out infinite alternate;
  opacity: 0.60;
}
.bgAurora.a3{
  background: conic-gradient(from 180deg at 50% 50%,
    rgba(0,240,255,0.10),
    rgba(255,61,166,0.10),
    rgba(120,90,255,0.10),
    rgba(120,255,70,0.08),
    rgba(0,240,255,0.10)
  );
  animation: auroraSpin 14s linear infinite;
  opacity: 0.45;
}
@keyframes auroraDrift1{ from{ transform: translate(-2%, -1%) scale(1.02) rotate(-2deg); } to{ transform: translate(2%, 1%) scale(1.06) rotate(2deg); } }
@keyframes auroraDrift2{ from{ transform: translate(2%, -2%) scale(1.02) rotate(3deg); } to{ transform: translate(-2%, 2%) scale(1.08) rotate(-3deg); } }
@keyframes auroraSpin{ from{ transform: rotate(0deg) scale(1.12); } to{ transform: rotate(360deg) scale(1.12); } }

.bgGrid{
  position:absolute; inset: 0; opacity: 0.12;
  background:
    linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(closest-side at 50% 45%, rgba(0,0,0,1), rgba(0,0,0,0));
  animation: gridSlide 10s linear infinite;
}
@keyframes gridSlide{ from{ transform: translate3d(0,0,0); } to{ transform: translate3d(-48px,-48px,0); } }

.bgSparks{
  position:absolute; inset: 0; opacity: 0.65;
  background:
    radial-gradient(2px 2px at 20% 30%, rgba(0,240,255,0.9), transparent 60%),
    radial-gradient(2px 2px at 35% 80%, rgba(255,61,166,0.9), transparent 60%),
    radial-gradient(2px 2px at 70% 40%, rgba(120,255,70,0.7), transparent 60%),
    radial-gradient(2px 2px at 85% 70%, rgba(120,90,255,0.9), transparent 60%),
    radial-gradient(2px 2px at 55% 15%, rgba(0,240,255,0.7), transparent 60%);
  filter: blur(0.2px);
  animation: sparksFloat 3.6s ease-in-out infinite alternate;
}
@keyframes sparksFloat{ from{ transform: translateY(0px) translateX(0px); opacity: 0.50; } to{ transform: translateY(-10px) translateX(8px); opacity: 0.80; } }

.wrap > *{ position: relative; z-index: 1; }
.enter{ animation: riseIn 420ms ease-out both; }
@keyframes riseIn{ from{ transform: translateY(12px); opacity: 0; } to{ transform: translateY(0); opacity: 1; } }

/* cards */
.neonCard{
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.06);
  border-radius: 18px;
  box-shadow:
    0 0 0 1px rgba(0,240,255,0.14),
    0 0 54px rgba(0,240,255,0.10),
    0 0 46px rgba(255,61,166,0.08),
    inset 0 0 26px rgba(0,0,0,0.44);
  backdrop-filter: blur(12px);
  overflow: hidden;
}
.neonText{ text-shadow: 0 0 18px rgba(0,240,255,0.34), 0 0 28px rgba(255,61,166,0.16); }

.panel{ max-width: 1100px; margin: 32px auto; padding: 18px; }
.title{ font-size: 34px; font-weight: 950; letter-spacing: -0.02em; }
.subtitle{ margin-top: 8px; opacity: 0.88; }

.hero{ display:grid; grid-template-columns: 1.15fr 0.85fr; gap: 12px; align-items: stretch; }
@media (max-width: 980px){ .hero{ grid-template-columns: 1fr; } }

.brand{ display:flex; gap: 14px; align-items:center; padding: 18px; }
.logoPulse{
  width: 62px; height: 62px; border-radius: 18px;
  display:grid; place-items:center;
  border: 1px solid rgba(0,240,255,0.28);
  background: rgba(0,240,255,0.10);
  box-shadow: 0 0 30px rgba(0,240,255,0.14);
  font-size: 26px; font-weight: 1000;
  animation: logoBreath 2.2s ease-in-out infinite;
}
@keyframes logoBreath{
  0%,100%{ transform: translateY(0) scale(1); filter: brightness(1); }
  50%{ transform: translateY(-2px) scale(1.03); filter: brightness(1.14); }
}

.legacyMenu{ padding: 14px; display:flex; flex-direction: column; gap: 10px; justify-content:center; }
.legacyTitle{ font-size: 16px; font-weight: 950; opacity: 0.95; }

.footerRow{ display:flex; align-items:center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
.miniLink{ color: rgba(255,255,255,0.88); text-decoration: none; opacity: 0.88; }
.miniLink:hover{ opacity: 1; text-decoration: underline; }

.pill{
  padding: 8px 10px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.06);
  border-radius: 999px;
  font-size: 13px;
  display:inline-flex;
  gap: 8px;
  align-items:center;
}
.neonPill{ box-shadow: 0 0 18px rgba(0,240,255,0.08); }
.muted{ opacity: 0.7; }
.dot{ width: 12px; height: 12px; border-radius: 999px; display:inline-block; }

.btn{
  border: 1px solid rgba(255,255,255,0.18);
  background: rgba(255,255,255,0.10);
  color: #fff;
  padding: 10px 12px;
  border-radius: 12px;
  cursor: pointer;
  font-weight: 950;
  transition: transform 120ms ease, box-shadow 160ms ease, background 160ms ease, filter 160ms ease;
}
.btn:hover{ background: rgba(255,255,255,0.14); transform: translateY(-1px); filter: brightness(1.05); }
.btn:active{ transform: translateY(0) scale(0.99); }
.btn.ghost{ background: transparent; }
.btn.primary{ background: rgba(0,240,255,0.16); border-color: rgba(0,240,255,0.34); }
.neonBtn{ box-shadow: 0 0 0 1px rgba(0,240,255,0.12), 0 0 18px rgba(0,240,255,0.12), 0 0 16px rgba(255,61,166,0.08); }
.btn.big{ padding: 12px 14px; border-radius: 14px; font-size: 14px; }
.zap{ filter: drop-shadow(0 0 12px rgba(0,240,255,0.34)); }

.topRow{ display:flex; align-items:flex-start; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.topActions{ display:flex; gap: 10px; flex-wrap: wrap; }

.boardGrid{
  margin-top: 12px;
  display:grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
@media (max-width: 980px){ .boardGrid{ grid-template-columns: 1fr; } }

.boardCard{
  text-align:left;
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.06);
  color: #fff;
  padding: 12px;
  cursor: pointer;
  transition: transform 140ms ease, box-shadow 180ms ease, background 180ms ease, filter 180ms ease;
  display:flex; flex-direction: column; gap: 10px;
}
.boardCard:hover{
  transform: translateY(-1px);
  background: rgba(255,255,255,0.09);
  box-shadow: 0 0 0 1px rgba(0,240,255,0.14), 0 0 26px rgba(0,240,255,0.10);
}
.boardCard:active{ transform: translateY(0) scale(0.995); filter: brightness(1.03); }

.cardHead{ display:flex; align-items:center; justify-content: space-between; gap: 10px; }
.cardName{ font-weight: 950; }
.cardTag{ font-size: 11px; padding: 3px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.24); opacity: 0.9; }
.cardDesc{ font-size: 12px; opacity: 0.84; }

.miniBoard{
  position: relative;
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.10);
  background:
    radial-gradient(520px 220px at 30% 30%, rgba(0,240,255,0.14), transparent 60%),
    radial-gradient(520px 220px at 70% 70%, rgba(255,61,166,0.10), transparent 62%),
    rgba(0,0,0,0.34);
  overflow: hidden;
  padding: 10px;
}
.miniGlow{
  position:absolute; inset:-30%;
  background: radial-gradient(closest-side, rgba(0,240,255,0.10), transparent 65%);
  filter: blur(22px);
  opacity: 0.8;
  animation: miniGlow 5.5s ease-in-out infinite alternate;
}
@keyframes miniGlow{ from{ transform: translate(-1%, -1%) scale(1.02); } to{ transform: translate(2%, 2%) scale(1.06); } }

.miniSvg{ position: relative; width: 100%; height: 160px; display:block; }

.pvEdge{
  stroke: rgba(240,250,255,0.55);
  stroke-width: 3.0;
  stroke-linecap: round;
  stroke-dasharray: 7 16;
  animation: pvFlow 3.2s linear infinite;
}
@keyframes pvFlow{ from{ stroke-dashoffset: 0; } to{ stroke-dashoffset: -64; } }

.pvDot{
  fill: rgba(255,255,255,0.90);
  stroke: rgba(0,0,0,0.76);
  stroke-width: 2;
  filter: drop-shadow(0 0 10px rgba(0,240,255,0.16));
}

.tapHint{
  position:absolute; right: 10px; bottom: 10px;
  display:flex; gap: 8px; align-items:center;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(0,0,0,0.26);
  font-size: 12px;
  opacity: 0.92;
}
.tapDot{
  width: 10px; height: 10px; border-radius: 999px;
  background: #00F0FF; box-shadow: 0 0 16px rgba(0,240,255,0.52);
  animation: tapPulse 1.2s ease-in-out infinite;
}
@keyframes tapPulse{ 0%,100%{ transform: scale(1); opacity: 0.75; } 50%{ transform: scale(1.25); opacity: 1; } }

.tinyNote{ margin-top: 10px; font-size: 12px; opacity: 0.82; }
code{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }

/* Modal */
.modal{ position: fixed; inset: 0; background: rgba(0,0,0,0.62); display: grid; place-items: center; padding: 16px; z-index: 50; }
.modalCard{ width: min(680px, 100%); padding: 16px; border-radius: 18px; }
.pop{ animation: popIn 240ms ease-out both; }
@keyframes popIn{ from{ transform: scale(0.96); opacity: 0; } to{ transform: scale(1); opacity: 1; } }
.modalTitle{ font-size: 20px; font-weight: 1000; }
.modalBtns{ display:flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }

.howGrid{ margin-top: 12px; display:grid; gap: 10px; }
.howStep{
  display:flex; gap: 10px; align-items:flex-start;
  padding: 12px; border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(255,255,255,0.05);
}
.howNum{
  width: 28px; height: 28px; border-radius: 10px;
  display:grid; place-items:center;
  border: 1px solid rgba(0,240,255,0.26);
  background: rgba(0,240,255,0.10);
  font-weight: 950;
}
.howHead{ font-weight: 950; }
.howText{ margin-top: 4px; font-size: 12px; opacity: 0.88; }
</style>