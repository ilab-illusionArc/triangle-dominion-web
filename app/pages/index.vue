<!-- app/pages/index.vue -->
<script setup lang="ts">
useHead({ title: 'Triangle Arena' })

/* =========================================================
   AUDIO (SFX toggle + BGM toggle)
========================================================= */
const audio = useAudioFx()

onMounted(() => {
  audio.initAudio()
  void audio.playBgm('bgm_menu')
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
  if (audio.sfxEnabled.value) audio.playSfx('ui_click')
}

/* =========================================================
   UI STATE
========================================================= */
const router = useRouter()
const step = ref<'menu' | 'board'>('menu')
const showHow = ref(false)

function goToBoardSelect() {
  audio.unlockAudio()
  audio.playSfx('ui_click')
  step.value = 'board'
}

function backToMenu() {
  audio.playSfx('ui_back')
  step.value = 'menu'
}

function startBoard(boardId: string) {
  audio.unlockAudio()
  audio.playSfx('ui_click')
  audio.stopBgm(false)
  router.push({ path: '/play', query: { board: boardId, autostart: '1' } })
}

function openHow() {
  audio.unlockAudio()
  audio.playSfx('ui_modal_open')
  showHow.value = true
}
function closeHow() {
  audio.playSfx('ui_modal_close')
  showHow.value = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (showHow.value) closeHow()
    else if (step.value === 'board') backToMenu()
  }
  if (e.key === 'Enter' && !showHow.value && step.value === 'menu') goToBoardSelect()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/* =========================================================
   BOARD PRESETS + SIMPLE PREVIEWS
   (kept light but still generates proper dot/edge preview)
========================================================= */
type Dot = { id: number; x: number; y: number; neighbors: number[] }

type BoardPreset = {
  id: string
  name: string
  description: string
  accent: string
  glow: string
  bg: string
}

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

  const pad = 70
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
  { id: 'circle', name: 'Bubble Arena', description: 'Round and bouncy.', accent: '#00F0FF', glow: 'rgba(0,240,255,0.30)', bg: 'radial-gradient(800px 360px at 25% 20%, rgba(0,240,255,0.20), transparent 62%)' },
  { id: 'triangle', name: 'Tri Peak', description: 'Sharp and fast.', accent: '#FF3DA6', glow: 'rgba(255,61,166,0.28)', bg: 'radial-gradient(800px 360px at 25% 20%, rgba(255,61,166,0.18), transparent 62%)' },
  { id: 'square', name: 'Pixel Square', description: 'Balanced grid feel.', accent: '#7BFF46', glow: 'rgba(123,255,70,0.22)', bg: 'radial-gradient(800px 360px at 25% 20%, rgba(123,255,70,0.16), transparent 62%)' },
  { id: 'rectangle', name: 'Neon Strip', description: 'Long arena lines.', accent: '#7C5AFF', glow: 'rgba(124,90,255,0.26)', bg: 'radial-gradient(800px 360px at 25% 20%, rgba(124,90,255,0.18), transparent 62%)' },
  { id: 'pentagon', name: 'Pentagon Park', description: 'Playful angles.', accent: '#FFBE00', glow: 'rgba(255,190,0,0.24)', bg: 'radial-gradient(800px 360px at 25% 20%, rgba(255,190,0,0.16), transparent 62%)' },
  { id: 'hexagon', name: 'Hex Hive', description: 'Many options.', accent: '#FF6B6B', glow: 'rgba(255,107,107,0.22)', bg: 'radial-gradient(800px 360px at 25% 20%, rgba(255,107,107,0.16), transparent 62%)' }
]

function buildBoardById(id: string) {
  if (id === 'circle') return presetCircle()
  if (id === 'triangle') return presetTriangle()
  if (id === 'square') return presetSquare()
  if (id === 'rectangle') return presetRectangle()
  if (id === 'pentagon') return presetPentagon()
  return presetHexagon()
}

type Preview = { dots: Dot[]; width: number; height: number; edges: Array<{ a: number; b: number; key: string }> }
function makeEdgeKey(a: number, b: number) {
  const x = Math.min(a, b)
  const y = Math.max(a, b)
  return `${x}_${y}`
}
function previewEdges(dots: Dot[]) {
  const seen = new Set<string>()
  const edges: Array<{ a: number; b: number; key: string }> = []
  for (const d of dots) {
    for (const n of d.neighbors) {
      const key = makeEdgeKey(d.id, n)
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
    <!-- Background -->
    <div class="bg" aria-hidden="true">
      <div class="iconWall"></div>
      <div class="topShade"></div>

      <div class="aurora a1"></div>
      <div class="aurora a2"></div>
      <div class="grid"></div>
      <div class="vignette"></div>
    </div>

    <!-- ===== MENU (simple, centered) ===== -->
    <main v-if="step === 'menu'" class="canvas">
      <div class="titleText">Triangle Arena</div>

      <img class="logo" src="/images/app-logo.png" alt="Triangle Arena" />

      <div class="actions">
        <button class="btn primary" @click="goToBoardSelect">Play</button>
        <button class="btn ghost" @click="openHow">How to Play</button>
      </div>

      <div class="soundBar">
        <button class="chip" :class="{ on: audio.sfxEnabled.value }" @click="toggleSfx">
          {{ audio.sfxEnabled.value ? '🔊 SFX On' : '🔇 SFX Off' }}
        </button>
        <button class="chip" :class="{ on: audio.bgmEnabled.value }" @click="toggleBgm">
          {{ audio.bgmEnabled.value ? '🎵 BGM On' : '🚫🎵 BGM Off' }}
        </button>
      </div>

      <div class="hint">Press <b>Enter</b> to open boards • <b>ESC</b> to close</div>
    </main>

    <!-- ===== BOARD SELECT (after clicking Play) ===== -->
    <main v-else class="boardCanvas">
      <div class="boardTop">
        <div class="boardTitle">Select Board</div>
        <button class="btn ghost smallBtn" @click="backToMenu">Back</button>
      </div>

      <div class="boardGrid">
        <button
          v-for="p in BOARD_PRESETS"
          :key="p.id"
          class="boardCard"
          :style="{ '--accent': p.accent, '--glow': p.glow, '--cardbg': p.bg }"
          @mouseenter="audio.playSfx('ui_hover', 0.55)"
          @focus="audio.playSfx('ui_hover', 0.45)"
          @click="startBoard(p.id)"
        >
          <div class="cardHead">
            <div class="cardName">{{ p.name }}</div>
            <div class="cardDesc">{{ p.description }}</div>
          </div>

          <div class="miniBoard">
            <svg
              v-if="previews[p.id]"
              class="miniSvg"
              :viewBox="`0 0 ${previews[p.id].width} ${previews[p.id].height}`"
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
            >
              <g opacity="0.22">
                <line
                  v-for="e in previews[p.id].edges"
                  :key="`e-${p.id}-${e.key}`"
                  :x1="previews[p.id].dots[e.a].x"
                  :y1="previews[p.id].dots[e.a].y"
                  :x2="previews[p.id].dots[e.b].x"
                  :y2="previews[p.id].dots[e.b].y"
                  class="pvEdge"
                />
              </g>
              <g>
                <circle
                  v-for="d in previews[p.id].dots"
                  :key="`d-${p.id}-${d.id}`"
                  :cx="d.x"
                  :cy="d.y"
                  r="6.6"
                  class="pvDot"
                />
              </g>
            </svg>
          </div>

          <div class="cardFoot">Click to start</div>
        </button>
      </div>

      <div class="soundBar boardSound">
        <button class="chip" :class="{ on: audio.sfxEnabled.value }" @click="toggleSfx">
          {{ audio.sfxEnabled.value ? '🔊 SFX On' : '🔇 SFX Off' }}
        </button>
        <button class="chip" :class="{ on: audio.bgmEnabled.value }" @click="toggleBgm">
          {{ audio.bgmEnabled.value ? '🎵 BGM On' : '🚫🎵 BGM Off' }}
        </button>
      </div>
    </main>

    <!-- How to Play Modal -->
    <div v-if="showHow" class="modal" @click.self="closeHow">
      <div class="modalCard">
        <div class="modalTop">
          <div class="modalTitle">How to Play</div>
          <button class="xBtn" @click="closeHow" aria-label="Close">✕</button>
        </div>

        <div class="steps">
          <div class="step">
            <div class="num">1</div>
            <div>
              <div class="head">Roll the Dice</div>
              <div class="text">You roll a D6. The result is how many edges you must draw this turn.</div>
            </div>
          </div>

          <div class="step">
            <div class="num">2</div>
            <div>
              <div class="head">Draw Exactly N Edges</div>
              <div class="text">Click a dot → choose a neighbor → draw a line. No crossing allowed.</div>
            </div>
          </div>

          <div class="step">
            <div class="num">3</div>
            <div>
              <div class="head">Claim Triangles</div>
              <div class="text">Complete 3 edges of a triangle to claim it instantly and score +1.</div>
            </div>
          </div>

          <div class="step">
            <div class="num">4</div>
            <div>
              <div class="head">Game Ends</div>
              <div class="text">When no legal moves remain. Highest triangle count wins.</div>
            </div>
          </div>
        </div>

        <div class="modalBtns">
          <button class="btn primary" @click="closeHow">Got it</button>
          <button class="btn ghost" @click="closeHow">Close</button>
        </div>

        <div class="small">Shortcut: press <b>ESC</b> to close.</div>
      </div>
    </div>
  </div>
</template>

<style>
*,
html { box-sizing: border-box; margin: 0; padding: 0; }

.wrap{
  min-height: 100vh;
  position: relative;
  overflow: hidden;
  display: grid;
  place-items: center;
  padding: 18px;
  color: #fff;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  background: #02030a;
}

/* Background */
.bg{ position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow:hidden; }
.aurora{ position:absolute; inset:-20%; filter: blur(26px); opacity:0.8; mix-blend-mode: screen; transform: translateZ(0); }
.aurora.a1{
  background:
    radial-gradient(900px 620px at 20% 18%, rgba(0,240,255,0.20), transparent 62%),
    radial-gradient(980px 650px at 82% 62%, rgba(255,61,166,0.16), transparent 64%),
    radial-gradient(700px 520px at 55% 10%, rgba(120,90,255,0.12), transparent 60%);
  animation: drift1 10s ease-in-out infinite alternate;
}
.aurora.a2{
  background:
    radial-gradient(900px 620px at 75% 22%, rgba(120,255,70,0.08), transparent 62%),
    radial-gradient(900px 620px at 40% 78%, rgba(0,240,255,0.10), transparent 62%),
    radial-gradient(700px 520px at 18% 70%, rgba(255,61,166,0.09), transparent 60%);
  animation: drift2 12s ease-in-out infinite alternate;
  opacity: 0.55;
}
@keyframes drift1{ from{ transform: translate(-2%,-1%) scale(1.03); } to{ transform: translate(2%,1%) scale(1.07); } }
@keyframes drift2{ from{ transform: translate(2%,-2%) scale(1.02); } to{ transform: translate(-2%,2%) scale(1.08); } }

.grid{
  position:absolute; inset:0; opacity:0.11;
  background:
    linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px);
  background-size: 54px 54px;
  mask-image: radial-gradient(closest-side at 50% 45%, rgba(0,0,0,1), rgba(0,0,0,0));
  animation: gridSlide 10s linear infinite;
}
@keyframes gridSlide{ from{ transform: translate3d(0,0,0);} to{ transform: translate3d(-54px,-54px,0);} }

.vignette{
  position:absolute; inset:-10%;
  background: radial-gradient(closest-side at 50% 30%, rgba(0,0,0,0), rgba(0,0,0,0.55) 72%, rgba(0,0,0,0.75));
}

/* ===== Menu canvas (simple centered) ===== */
.canvas{
  z-index: 1;
  width: min(520px, 92vw);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 16px;
  padding: 10px 8px;
}

.titleText{
  font-size: 34px;
  font-weight: 1000;
  letter-spacing: -0.03em;
  text-shadow: 0 0 18px rgba(0,240,255,0.22), 0 0 20px rgba(255,61,166,0.10);
}

.logo{
  width: min(220px, 62vw);
  height: auto;
  object-fit: contain;
  filter: drop-shadow(0 0 22px rgba(0,240,255,0.22)) drop-shadow(0 0 18px rgba(255,61,166,0.10));
  user-select: none;
  -webkit-user-drag: none;
}

/* buttons less wide */
.actions{
  width: 100%;
  display: grid;
  gap: 10px;
  justify-items: center;
}
.actions .btn{ width: min(320px, 86%); }

.btn{
  border: 1px solid rgba(255,255,255,0.18);
  background: rgba(255,255,255,0.10);
  color: #fff;
  padding: 12px 14px;
  border-radius: 14px;
  cursor: pointer;
  font-weight: 900;
  font-size: 15px;
  transition: transform 120ms ease, background 160ms ease, box-shadow 160ms ease, filter 160ms ease;
}
.btn:hover{
  background: rgba(255,255,255,0.14);
  transform: translateY(-1px);
  filter: brightness(1.05);
  box-shadow: 0 0 0 1px rgba(0,240,255,0.10), 0 0 22px rgba(0,240,255,0.08);
}
.btn:active{ transform: translateY(0) scale(0.99); }
.btn.primary{
  background:
    radial-gradient(900px 420px at 20% 20%, rgba(0,240,255,0.22), transparent 62%),
    linear-gradient(180deg, rgba(0,240,255,0.18), rgba(255,61,166,0.10));
  border-color: rgba(0,240,255,0.32);
}
.btn.ghost{ background: rgba(0,0,0,0.16); }
.btn.smallBtn{ padding: 10px 12px; font-size: 14px; border-radius: 12px; }

.soundBar{
  margin-top: 10px;
  width: 100%;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
@media (max-width: 420px){
  .soundBar{ grid-template-columns: 1fr; }
}

.chip{
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(0,0,0,0.22);
  color: #fff;
  border-radius: 999px;
  padding: 10px 12px;
  cursor: pointer;
  font-weight: 900;
  font-size: 13px;
  transition: transform 120ms ease, background 160ms ease, box-shadow 160ms ease;
}
.chip:hover{ transform: translateY(-1px); background: rgba(255,255,255,0.08); }
.chip.on{
  border-color: rgba(0,240,255,0.26);
  box-shadow: 0 0 0 1px rgba(0,240,255,0.10), 0 0 20px rgba(0,240,255,0.10);
}

.hint{
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.78;
}

/* ===== Board select canvas ===== */
.boardCanvas{
  z-index: 1;
  width: min(920px, 96vw);
  display:flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}

.boardTop{
  width: 100%;
  display:flex;
  align-items:center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 4px;
}
.boardTitle{
  font-size: 22px;
  font-weight: 1000;
  letter-spacing: -0.02em;
  text-shadow: 0 0 18px rgba(0,240,255,0.18);
}

.boardGrid{
  width: 100%;
  display:grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
@media (max-width: 980px){
  .boardGrid{ grid-template-columns: 1fr; }
}

.boardCard{
  --accent: #00F0FF;
  --glow: rgba(0,240,255,0.30);
  --cardbg: radial-gradient(800px 360px at 25% 20%, rgba(0,240,255,0.18), transparent 62%);

  border: 1px solid rgba(255,255,255,0.12);
  background: var(--cardbg), rgba(255,255,255,0.06);
  border-radius: 16px;
  padding: 12px;
  color: #fff;
  cursor:pointer;
  display:flex;
  flex-direction: column;
  gap: 10px;
  transition: transform 140ms ease, box-shadow 180ms ease, filter 180ms ease;
}
.boardCard:hover{
  transform: translateY(-1px);
  box-shadow: 0 0 0 1px rgba(255,255,255,0.10), 0 0 28px var(--glow);
  filter: brightness(1.03);
}

.cardHead{ display:flex; flex-direction: column; gap: 2px; text-align:left; }
.cardName{ font-weight: 1000; letter-spacing:-0.01em; }
.cardDesc{ font-size: 12px; opacity: 0.84; }

.miniBoard{
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(0,0,0,0.26);
  border-radius: 14px;
  overflow:hidden;
  padding: 10px;
}
.miniSvg{ width: 100%; height: 150px; display:block; }
.pvEdge{
  stroke: rgba(240,250,255,0.55);
  stroke-width: 3.0;
  stroke-linecap: round;
  stroke-dasharray: 7 16;
  animation: pvFlow 3.2s linear infinite;
}
@keyframes pvFlow{ from{ stroke-dashoffset: 0; } to{ stroke-dashoffset: -64; } }
.pvDot{
  fill: rgba(255,255,255,0.92);
  stroke: rgba(0,0,0,0.75);
  stroke-width: 2;
}

.cardFoot{
  font-size: 12px;
  opacity: 0.78;
  text-align:left;
}
.boardSound{ margin-top: 6px; }

/* ===== Modal ===== */
.modal{
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.62);
  display: grid; place-items: center;
  padding: 16px;
  z-index: 50;
}
.modalCard{
  width: min(680px, 94vw);
  border-radius: 18px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.06);
  backdrop-filter: blur(12px);
  box-shadow: 0 0 0 1px rgba(0,240,255,0.12), 0 0 40px rgba(0,240,255,0.10);
  padding: 16px;
  color: #fff;
}
.modalTop{ display:flex; align-items:center; justify-content: space-between; gap: 10px; }
.modalTitle{ font-size: 18px; font-weight: 1000; }
.xBtn{
  width: 40px; height: 40px;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(0,0,0,0.26);
  color:#fff;
  cursor:pointer;
  font-weight: 1000;
  transition: transform 120ms ease, background 160ms ease;
}
.xBtn:hover{ transform: translateY(-1px); background: rgba(255,255,255,0.08); }
.xBtn:active{ transform: translateY(0) scale(0.99); }

.steps{ margin-top: 12px; display:grid; gap: 10px; }
.step{
  display:flex; gap: 10px; align-items:flex-start;
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(0,0,0,0.18);
  border-radius: 14px;
  padding: 12px;
}
.num{
  width: 28px; height: 28px;
  border-radius: 10px;
  display:grid; place-items:center;
  border: 1px solid rgba(0,240,255,0.26);
  background: rgba(0,240,255,0.10);
  font-weight: 1000;
}
.head{ font-weight: 1000; }
.text{ margin-top: 4px; font-size: 12px; opacity: 0.86; line-height: 1.45; }

.modalBtns{ margin-top: 14px; display:flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
.small{ margin-top: 10px; font-size: 12px; opacity: 0.78; }
.iconWall{
  position: absolute;
  inset: 0;
  background-image: url('/images/triangle-arena-app-icon.png');
  background-repeat: no-repeat;
  background-position: 50% 40%;
  background-size: cover;
  opacity: 0.16;               /* tweak: 0.10 - 0.22 */
  filter: saturate(1.05) contrast(1.05);
  transform: translateZ(0);
}

.topShade{
  position: absolute;
  inset: 0;
  /* black shade on top */
  background: linear-gradient(
    to bottom,
    rgba(0,0,0,0.92) 0%,
    rgba(0,0,0,0.55) 22%,
    rgba(0,0,0,0.18) 52%,
    rgba(0,0,0,0.00) 80%
  );
  pointer-events: none;
}
</style>