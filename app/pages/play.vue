<!-- app/pages/play.vue -->
<script setup lang="ts">
useHead({ title: 'Triangle Arena — vs AI' })

/* =========================================================
   ROUTE (SSR-SAFE INITIALIZATION)
   Fix: avoid theme changing after refresh (SSR hydration mismatch)
========================================================= */
const route = useRoute()

function normalizeBoardId(v: unknown) {
  const s = typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : ''
  return s || 'hexagon'
}
const initialBoardId = normalizeBoardId(route.query.board)
const shouldAutostart = String(route.query.autostart ?? '') === '1'

/* =========================================================
   AUDIO (game bgm + sfx everywhere)
========================================================= */
const audio = useAudioFx()

onMounted(() => {
  audio.initAudio()
  void audio.playBgm('bgm_game')

  // If autostart is requested, do it after audio init (no SSR window access).
  if (shouldAutostart && phase.value === 'setup') {
    startGame(true)
  }
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
   TYPES
========================================================= */
type Dot = { id: number; x: number; y: number; neighbors: number[] }
type EdgeKey = string
type Edge = { a: number; b: number; key: EdgeKey; t: number; owner: number }

type Player = { id: number; name: string; color: string; score: number; isAI?: boolean }
type Triangle = {
  id: string
  a: number
  b: number
  c: number
  edges: [EdgeKey, EdgeKey, EdgeKey]
  owner: number | null
  claimedAt?: number
}
type Phase = 'setup' | 'playing' | 'gameover'

/* =========================================================
   UTILS
========================================================= */
function makeEdgeKey(a: number, b: number): EdgeKey {
  const x = Math.min(a, b)
  const y = Math.max(a, b)
  return `${x}_${y}`
}
function triId(a: number, b: number, c: number) {
  const s = [a, b, c].sort((x, y) => x - y)
  return `${s[0]}_${s[1]}_${s[2]}`
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n))
}
function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

/* =========================================================
   SHAPE BOARDS
========================================================= */
function makeTriField(opts?: { rows?: number; cols?: number; spacing?: number; margin?: number }) {
  const rows = opts?.rows ?? 12
  const cols = opts?.cols ?? 14
  const s = opts?.spacing ?? 54
  const m = opts?.margin ?? 84

  const rowDy = Math.sin(Math.PI / 3) * s
  const idx = (r: number, c: number) => r * cols + c

  const dots: { id: number; x: number; y: number; r: number; c: number }[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = m + c * s + (r % 2 ? s / 2 : 0)
      const y = m + r * rowDy
      dots.push({ id: idx(r, c), x, y, r, c })
    }
  }

  const neighborSet = new Map<number, Set<number>>()
  const add = (a: number, b: number) => {
    if (a === b) return
    if (!neighborSet.get(a)) neighborSet.set(a, new Set())
    neighborSet.get(a)!.add(b)
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

/* =========================================================
   BOARD PRESETS
========================================================= */
type BoardPreset = {
  id: string
  name: string
  tag: 'Shape'
  description: string
  build: () => { dots: Dot[]; width: number; height: number }
  accent: string
  glow: string
  bg: string
  chip: string
}

const BOARD_PRESETS: BoardPreset[] = [
  {
    id: 'circle',
    name: 'Bubble Arena',
    tag: 'Shape',
    description: 'Round and bouncy.',
    build: presetCircle,
    accent: '#00F0FF',
    glow: 'rgba(0,240,255,0.32)',
    bg: 'radial-gradient(900px 420px at 20% 20%, rgba(0,240,255,0.22), transparent 62%), radial-gradient(700px 320px at 75% 70%, rgba(120,90,255,0.14), transparent 62%)',
    chip: 'rgba(0,240,255,0.14)'
  },
  {
    id: 'triangle',
    name: 'Tri Peak',
    tag: 'Shape',
    description: 'Sharp corners, quick fights.',
    build: presetTriangle,
    accent: '#FF3DA6',
    glow: 'rgba(255,61,166,0.30)',
    bg: 'radial-gradient(900px 420px at 20% 20%, rgba(255,61,166,0.22), transparent 62%), radial-gradient(700px 320px at 80% 70%, rgba(255,190,0,0.12), transparent 62%)',
    chip: 'rgba(255,61,166,0.14)'
  },
  {
    id: 'square',
    name: 'Pixel Square',
    tag: 'Shape',
    description: 'Balanced grid feel.',
    build: presetSquare,
    accent: '#7BFF46',
    glow: 'rgba(123,255,70,0.26)',
    bg: 'radial-gradient(900px 420px at 20% 20%, rgba(123,255,70,0.18), transparent 62%), radial-gradient(700px 320px at 78% 72%, rgba(0,240,255,0.12), transparent 62%)',
    chip: 'rgba(123,255,70,0.14)'
  },
  {
    id: 'rectangle',
    name: 'Neon Strip',
    tag: 'Shape',
    description: 'Long arena lines.',
    build: presetRectangle,
    accent: '#7C5AFF',
    glow: 'rgba(124,90,255,0.30)',
    bg: 'radial-gradient(900px 420px at 18% 20%, rgba(124,90,255,0.22), transparent 62%), radial-gradient(700px 320px at 78% 72%, rgba(255,61,166,0.12), transparent 62%)',
    chip: 'rgba(124,90,255,0.14)'
  },
  {
    id: 'pentagon',
    name: 'Pentagon Park',
    tag: 'Shape',
    description: 'Playful angles.',
    build: presetPentagon,
    accent: '#FFBE00',
    glow: 'rgba(255,190,0,0.28)',
    bg: 'radial-gradient(900px 420px at 20% 20%, rgba(255,190,0,0.20), transparent 62%), radial-gradient(700px 320px at 80% 70%, rgba(0,240,255,0.10), transparent 62%)',
    chip: 'rgba(255,190,0,0.14)'
  },
  {
    id: 'hexagon',
    name: 'Hex Hive',
    tag: 'Shape',
    description: 'Many options.',
    build: presetHexagon,
    accent: '#FF6B6B',
    glow: 'rgba(255,107,107,0.26)',
    bg: 'radial-gradient(900px 420px at 20% 20%, rgba(255,107,107,0.18), transparent 62%), radial-gradient(700px 320px at 80% 70%, rgba(124,90,255,0.12), transparent 62%)',
    chip: 'rgba(255,107,107,0.14)'
  }
]

/* =========================================================
   BOARD STATE (SSR-SAFE)
========================================================= */
const selectedBoardId = ref<string>(initialBoardId)
function buildBoardById(id: string) {
  const p = BOARD_PRESETS.find((x) => x.id === id) ?? BOARD_PRESETS[0]
  return p.build()
}
const board = ref(buildBoardById(selectedBoardId.value))

const dotsById = computed(() => {
  const m = new Map<number, Dot>()
  for (const d of board.value.dots) m.set(d.id, d)
  return m
})
const selectedPreset = computed(() => BOARD_PRESETS.find((p) => p.id === selectedBoardId.value) ?? BOARD_PRESETS[0])

/* =========================================================
   PHASE / PLAYERS
========================================================= */
const phase = ref<Phase>('setup')
const players = ref<Player[]>([])
const currentPlayerIndex = ref(0)
const currentPlayer = computed(() => players.value[currentPlayerIndex.value])

/* =========================================================
   DICE
========================================================= */
const rolled = ref<number | null>(null)
const linesLeft = ref(0)
const message = ref('')
const diceAnimating = ref(false)
const diceSettle = ref(false)

function flash(msg: string) {
  message.value = msg
  window.clearTimeout((flash as any)._t)
  ;(flash as any)._t = window.setTimeout(() => (message.value = ''), 1100)
}

const pipMap: Record<number, Array<[number, number]>> = {
  1: [[0, 0]],
  2: [
    [-1, -1],
    [1, 1]
  ],
  3: [
    [-1, -1],
    [0, 0],
    [1, 1]
  ],
  4: [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1]
  ],
  5: [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1]
  ],
  6: [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1]
  ]
}
const diceValue = computed(() => rolled.value ?? 1)

async function animateDiceTo(finalValue: number) {
  diceAnimating.value = true
  diceSettle.value = false

  const ticks = 16
  for (let i = 0; i < ticks; i++) {
    rolled.value = Math.floor(Math.random() * 6) + 1
    await sleep(16 + i * 8)
  }

  rolled.value = finalValue
  diceAnimating.value = false

  diceSettle.value = true
  window.setTimeout(() => (diceSettle.value = false), 260)
}

/* =========================================================
   EDGE STATE
========================================================= */
const edges = ref<Edge[]>([])
const edgeSet = ref(new Set<EdgeKey>())

function hasEdge(a: number, b: number) {
  return edgeSet.value.has(makeEdgeKey(a, b))
}
function edgeExists(key: EdgeKey) {
  return edgeSet.value.has(key)
}
function addEdge(a: number, b: number) {
  const key = makeEdgeKey(a, b)
  if (edgeSet.value.has(key)) return false
  edgeSet.value.add(key)
  edges.value.push({
    a: Math.min(a, b),
    b: Math.max(a, b),
    key,
    t: performance.now(),
    owner: currentPlayer.value?.id ?? 0
  })
  return true
}
function removeEdgeKey(key: EdgeKey) {
  if (!edgeSet.value.has(key)) return
  edgeSet.value.delete(key)
  edges.value = edges.value.filter((e) => e.key !== key)
}

/* =========================================================
   NO-CROSSING GEOMETRY
========================================================= */
type Pt = { x: number; y: number }
function orient(a: Pt, b: Pt, c: Pt) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}
function onSegment(a: Pt, b: Pt, p: Pt) {
  return (
    Math.min(a.x, b.x) <= p.x + 1e-9 &&
    p.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) <= p.y + 1e-9 &&
    p.y <= Math.max(a.y, b.y) + 1e-9
  )
}
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
  const minAx = Math.min(a.x, b.x),
    maxAx = Math.max(a.x, b.x)
  const minAy = Math.min(a.y, b.y),
    maxAy = Math.max(a.y, b.y)
  const minCx = Math.min(c.x, d.x),
    maxCx = Math.max(c.x, d.x)
  const minCy = Math.min(c.y, d.y),
    maxCy = Math.max(c.y, d.y)
  if (maxAx < minCx || maxCx < minAx || maxAy < minCy || maxCy < minAy) return false

  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)

  if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)) return true

  if (Math.abs(o1) < 1e-9 && onSegment(a, b, c)) return true
  if (Math.abs(o2) < 1e-9 && onSegment(a, b, d)) return true
  if (Math.abs(o3) < 1e-9 && onSegment(c, d, a)) return true
  if (Math.abs(o4) < 1e-9 && onSegment(c, d, b)) return true
  return false
}
function wouldCrossExistingEdge(aId: number, bId: number) {
  const a = dotsById.value.get(aId)!
  const b = dotsById.value.get(bId)!
  const A: Pt = { x: a.x, y: a.y }
  const B: Pt = { x: b.x, y: b.y }

  for (const e of edges.value) {
    if (e.a === aId || e.b === aId || e.a === bId || e.b === bId) continue
    const c = dotsById.value.get(e.a)!
    const d = dotsById.value.get(e.b)!
    const C: Pt = { x: c.x, y: c.y }
    const D: Pt = { x: d.x, y: d.y }
    if (segmentsCross(A, B, C, D)) return true
  }
  return false
}

/* =========================================================
   TRIANGLES
========================================================= */
const triangles = ref<Triangle[]>([])
const triByEdge = ref(new Map<EdgeKey, Triangle[]>())

function buildTriangles() {
  const dots = board.value.dots
  const dotMap = dotsById.value
  const triMap = new Map<string, Triangle>()

  for (const aDot of dots) {
    const a = aDot.id
    const neigh = aDot.neighbors
    for (let i = 0; i < neigh.length; i++) {
      for (let j = i + 1; j < neigh.length; j++) {
        const b = neigh[i]
        const c = neigh[j]
        const bDot = dotMap.get(b)
        if (!bDot) continue
        if (!bDot.neighbors.includes(c)) continue

        const id = triId(a, b, c)
        if (triMap.has(id)) continue

        triMap.set(id, {
          id,
          a,
          b,
          c,
          edges: [makeEdgeKey(a, b), makeEdgeKey(b, c), makeEdgeKey(a, c)],
          owner: null
        })
      }
    }
  }

  const all = Array.from(triMap.values())
  const index = new Map<EdgeKey, Triangle[]>()
  for (const t of all) {
    for (const ek of t.edges) {
      if (!index.get(ek)) index.set(ek, [])
      index.get(ek)!.push(t)
    }
  }

  triangles.value = all
  triByEdge.value = index
}
watch(
  () => board.value.dots.length,
  () => buildTriangles(),
  { immediate: true }
)

function claimTrianglesForEdge(edgeKey: EdgeKey) {
  const list = triByEdge.value.get(edgeKey) ?? []
  let claimed = 0
  for (const t of list) {
    if (t.owner != null) continue
    const [e1, e2, e3] = t.edges
    if (edgeExists(e1) && edgeExists(e2) && edgeExists(e3)) {
      t.owner = currentPlayer.value.id
      t.claimedAt = performance.now()
      currentPlayer.value.score += 1
      claimed++
    }
  }
  return claimed
}

function triPoints(t: Triangle) {
  const a = dotsById.value.get(t.a)!
  const b = dotsById.value.get(t.b)!
  const c = dotsById.value.get(t.c)!
  return `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y}`
}
function playerById(pid: number | null) {
  if (pid == null) return null
  return players.value.find((p) => p.id === pid) || null
}

/* =========================================================
   LEGAL MOVES
========================================================= */
type Move = { a: number; b: number; key: EdgeKey }

function allPotentialNeighborEdges(): Move[] {
  const moves: Move[] = []
  for (const d of board.value.dots) {
    for (const n of d.neighbors) {
      if (d.id < n) moves.push({ a: d.id, b: n, key: makeEdgeKey(d.id, n) })
    }
  }
  return moves
}
const allEdgesOnce = computed(() => allPotentialNeighborEdges())

function isLegalMove(a: number, b: number) {
  if (hasEdge(a, b)) return false
  const da = dotsById.value.get(a)
  if (!da?.neighbors.includes(b)) return false
  if (wouldCrossExistingEdge(a, b)) return false
  return true
}
function legalMovesList(): Move[] {
  const legal: Move[] = []
  for (const m of allEdgesOnce.value) if (isLegalMove(m.a, m.b)) legal.push(m)
  return legal
}
const remainingLegalMovesCount = computed(() => legalMovesList().length)
function hasAnyLegalMove() {
  return remainingLegalMovesCount.value > 0
}

/* =========================================================
   CRITICAL FIX: Dice feasibility cap
========================================================= */
function estimateMaxDrawableThisTurn(maxDepth = 6, tries = 90): number {
  const baseLegal = legalMovesList()
  if (!baseLegal.length) return 0
  const depthCap = Math.min(maxDepth, baseLegal.length)
  let best = 1

  const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]

  for (let t = 0; t < tries; t++) {
    const addedKeys: EdgeKey[] = []
    let count = 0

    for (let step = 0; step < depthCap; step++) {
      const legal = legalMovesList()
      if (!legal.length) break
      const m = pick(legal)
      addEdge(m.a, m.b)
      addedKeys.push(m.key)
      count++
      if (count > best) best = count
      if (best >= depthCap) break
    }

    for (let i = addedKeys.length - 1; i >= 0; i--) removeEdgeKey(addedKeys[i])
  }

  return best
}

/* =========================================================
   GAME OVER CHECK
========================================================= */
const selectedDotId = ref<number | null>(null)

function endGameIfNoMoves() {
  if (!hasAnyLegalMove()) {
    phase.value = 'gameover'
    rolled.value = null
    linesLeft.value = 0
    selectedDotId.value = null
    flash('Game Over')
    audio.playSfx('game_over')
    audio.playSfx('win_fanfare', 0.85)
  }
}

/* ✅ Can roll only if there is at least 1 legal move left */
const canRoll = computed(() => {
  if (phase.value !== 'playing') return false
  if (rolled.value != null && linesLeft.value > 0) return false
  if (!currentPlayer.value) return false
  if (currentPlayer.value.isAI) return false
  return remainingLegalMovesCount.value > 0
})

async function rollDice() {
  if (phase.value !== 'playing') return
  if (rolled.value != null && linesLeft.value > 0) return

  if (remainingLegalMovesCount.value <= 0) {
    endGameIfNoMoves()
    return
  }

  audio.unlockAudio()
  audio.playSfx('dice_roll')

  const feasible = estimateMaxDrawableThisTurn(6, 90)
  const cap = Math.min(6, feasible)

  if (cap <= 0) {
    await animateDiceTo(1)
    endGameIfNoMoves()
    return
  }

  const n = Math.floor(Math.random() * cap) + 1

  await animateDiceTo(n)
  audio.playSfx('dice_land')

  linesLeft.value = n
  selectedDotId.value = null
  flash(`${currentPlayer.value.name}`)

  if (currentPlayer.value.isAI) void aiPlayTurn()
}

/* =========================================================
   TURN HELPERS
========================================================= */
async function endTurn() {
  audio.playSfx('turn_end', 0.7)

  rolled.value = null
  linesLeft.value = 0
  selectedDotId.value = null

  endGameIfNoMoves()
  if (phase.value === 'gameover') return

  currentPlayerIndex.value = (currentPlayerIndex.value + 1) % players.value.length

  if (phase.value === 'playing' && currentPlayer.value.isAI) {
    await sleep(420)
    await rollDice()
  }
}

/* =========================================================
   SELECTION + CLICK CONNECT
========================================================= */
const selectedDot = computed(() => (selectedDotId.value == null ? null : dotsById.value.get(selectedDotId.value) || null))

const eligibleNeighborIds = computed(() => {
  const s = new Set<number>()
  if (phase.value !== 'playing') return s
  if (!selectedDot.value) return s
  if (currentPlayer.value?.isAI) return s
  if (rolled.value == null || linesLeft.value <= 0) return s

  const a = selectedDot.value.id
  for (const n of selectedDot.value.neighbors) {
    if (isLegalMove(a, n)) s.add(n)
  }
  return s
})

function onDotClick(id: number) {
  if (phase.value !== 'playing') return
  if (currentPlayer.value.isAI) return

  if (!hasAnyLegalMove()) {
    endGameIfNoMoves()
    return
  }

  audio.unlockAudio()

  if (rolled.value == null || linesLeft.value <= 0) {
    selectedDotId.value = selectedDotId.value === id ? null : id
    audio.playSfx('dot_select', 0.75)
    return
  }

  if (selectedDotId.value == null) {
    selectedDotId.value = id
    audio.playSfx('dot_select', 0.75)
    return
  }

  const a = selectedDotId.value
  const b = id

  if (a === b) {
    selectedDotId.value = null
    audio.playSfx('ui_error', 0.7)
    return
  }

  const da = dotsById.value.get(a)
  if (!da?.neighbors.includes(b)) {
    flash('Pick a neighbor')
    selectedDotId.value = b
    audio.playSfx('edge_block')
    return
  }

  if (hasEdge(a, b)) {
    flash('Already drawn')
    selectedDotId.value = b
    audio.playSfx('edge_block')
    return
  }

  if (wouldCrossExistingEdge(a, b)) {
    flash('No crossing!')
    selectedDotId.value = b
    audio.playSfx('edge_block')
    return
  }

  const ok = addEdge(a, b)
  if (!ok) return

  audio.playSfx('edge_draw')

  const key = makeEdgeKey(a, b)
  linesLeft.value = Math.max(0, linesLeft.value - 1)

  const got = claimTrianglesForEdge(key)
  if (got === 1) audio.playSfx('triangle_claim')
  else if (got > 1) audio.playSfx('triangle_multi')

  if (got > 0) flash(`🎉 +${got}`)

  selectedDotId.value = b

  if (!hasAnyLegalMove()) {
    endGameIfNoMoves()
    return
  }

  if (linesLeft.value === 0) void endTurn()
}

/* =========================================================
   AI
========================================================= */
const moveByKey = computed(() => {
  const m = new Map<EdgeKey, Move>()
  for (const mv of allEdgesOnce.value) m.set(mv.key, mv)
  return m
})

function edgeCenterBonus(a: number, b: number) {
  const A = dotsById.value.get(a)!
  const B = dotsById.value.get(b)!
  const cx = (A.x + B.x) / 2
  const cy = (A.y + B.y) / 2
  const bx = board.value.width / 2
  const by = board.value.height / 2
  const dx = cx - bx
  const dy = cy - by
  const dist = Math.sqrt(dx * dx + dy * dy)
  return 1 - clamp(dist / Math.max(board.value.width, board.value.height), 0, 1)
}

function triStatsIfAddEdge(edgeKey: EdgeKey) {
  const list = triByEdge.value.get(edgeKey) ?? []
  let immediate = 0
  let setup = 0
  let danger = 0
  const exists = (ek: EdgeKey) => (ek === edgeKey ? true : edgeExists(ek))

  for (const t of list) {
    if (t.owner != null) continue
    const [e1, e2, e3] = t.edges
    const missing = [e1, e2, e3].filter((ek) => !exists(ek))
    if (missing.length === 0) immediate++
    else if (missing.length === 1) {
      setup++
      const missKey = missing[0]
      const mv = moveByKey.value.get(missKey)
      if (mv && isLegalMove(mv.a, mv.b)) danger++
    }
  }
  return { immediate, setup, danger }
}

function opponentBestImmediateAfter(edgeKey: EdgeKey) {
  const legal = legalMovesList()
  if (!legal.length) return 0
  const exists = (ek: EdgeKey) => (ek === edgeKey ? true : edgeExists(ek))
  let best = 0

  for (const mv of legal) {
    if (mv.key === edgeKey) continue
    const list = triByEdge.value.get(mv.key) ?? []
    let would = 0
    const exists2 = (ek: EdgeKey) => (ek === mv.key ? true : exists(ek))
    for (const t of list) {
      if (t.owner != null) continue
      const [e1, e2, e3] = t.edges
      if (exists2(e1) && exists2(e2) && exists2(e3)) would++
    }
    if (would > best) best = would
  }
  return best
}

function pickAIMoveWise(linesRemaining: number): Move | null {
  const legal = legalMovesList()
  if (!legal.length) return null

  let bestScore = -Infinity
  let best: Move[] = []

  for (const m of legal) {
    const { immediate, setup, danger } = triStatsIfAddEdge(m.key)
    const afterLines = linesRemaining - 1

    const setupWeight = afterLines > 0 ? 700 : 60
    const dangerWeight = afterLines > 0 ? 135 : 680

    const oppBest = opponentBestImmediateAfter(m.key)
    const oppWeight = afterLines > 0 ? 190 : 720

    const center = edgeCenterBonus(m.a, m.b)

    const score =
      immediate * 5200 +
      setup * setupWeight -
      danger * dangerWeight -
      oppBest * oppWeight +
      center * 26 +
      Math.random() * 0.18

    if (score > bestScore + 1e-9) {
      bestScore = score
      best = [m]
    } else if (Math.abs(score - bestScore) < 1e-9) {
      best.push(m)
    }
  }

  return best[Math.floor(Math.random() * best.length)] || legal[0]
}

async function aiPlayTurn() {
  if (phase.value !== 'playing') return
  if (!currentPlayer.value.isAI) return
  if (rolled.value == null || linesLeft.value <= 0) return

  await sleep(160)

  while (linesLeft.value > 0 && phase.value === 'playing' && currentPlayer.value.isAI) {
    const move = pickAIMoveWise(linesLeft.value)
    if (!move) {
      endGameIfNoMoves()
      break
    }

    addEdge(move.a, move.b)
    audio.playSfx('ai_move', 0.55)

    linesLeft.value = Math.max(0, linesLeft.value - 1)

    const got = claimTrianglesForEdge(move.key)
    if (got === 1) audio.playSfx('triangle_claim', 0.9)
    else if (got > 1) audio.playSfx('triangle_multi', 0.95)

    if (got > 0) flash(`🤖 +${got}`)

    if (!hasAnyLegalMove()) {
      endGameIfNoMoves()
      return
    }

    await sleep(150)
  }

  if (phase.value === 'playing' && currentPlayer.value.isAI && linesLeft.value === 0) {
    await endTurn()
  }
}

/* =========================================================
   SETUP / RESET / LOAD
========================================================= */
function hardResetState() {
  edges.value = []
  edgeSet.value = new Set()
  rolled.value = null
  linesLeft.value = 0
  selectedDotId.value = null
  message.value = ''
  currentPlayerIndex.value = 0

  for (const t of triangles.value) t.owner = null
  for (const p of players.value) p.score = 0
}

// SSR-safe “set board” (no audio, no window assumptions)
function setBoardIdSSR(id: string) {
  const safe = BOARD_PRESETS.find((x) => x.id === id)?.id ?? BOARD_PRESETS[0].id
  selectedBoardId.value = safe
  board.value = buildBoardById(safe)
  buildTriangles()
  hardResetState()
}

// Client action (with audio)
function loadBoard(id: string) {
  audio.unlockAudio()
  audio.playSfx('ui_click', 0.9)
  setBoardIdSSR(id)
}

// ✅ Keep URL in sync without theme flicker on refresh
watch(
  () => route.query.board,
  (v) => {
    const id = normalizeBoardId(v)
    if (id !== selectedBoardId.value) setBoardIdSSR(id)
  },
  { immediate: true }
)

function startGame(silent = false) {
  if (!silent) {
    audio.unlockAudio()
    audio.playSfx('ui_click')
  }

  players.value = [
    { id: 0, name: 'You', color: '#00F0FF', score: 0, isAI: false },
    { id: 1, name: 'AI', color: '#FF3DA6', score: 0, isAI: true }
  ]
  hardResetState()
  phase.value = 'playing'
}

function resetMatch() {
  audio.unlockAudio()
  audio.playSfx('ui_click')
  hardResetState()
  phase.value = 'playing'
}

function backToSetup() {
  audio.unlockAudio()
  audio.playSfx('ui_back')
  audio.stopBgm(false)
  navigateTo('/')
}

/* =========================================================
   WINNER
========================================================= */
const winners = computed(() => {
  if (phase.value !== 'gameover') return []
  const max = Math.max(...players.value.map((p) => p.score))
  return players.value.filter((p) => p.score === max)
})

/* =========================================================
   RENDER HELPERS
========================================================= */
function playerFill(t: Triangle) {
  return playerById(t.owner)?.color ?? 'transparent'
}
function edgeStroke(e: Edge) {
  const p = playerById(e.owner)
  return p?.color ?? 'rgba(240,250,255,0.92)'
}
const canRollTitle = computed(() => (canRoll.value ? 'Roll' : ''))
const themeVars = computed(() => ({
  '--accent': selectedPreset.value.accent,
  '--glow': selectedPreset.value.glow,
  '--cardbg': selectedPreset.value.bg,
  '--chip': selectedPreset.value.chip
}))
</script>

<template>
  <div class="wrap" :style="themeVars" @pointerdown="audio.unlockAudio()">
    <!-- background -->
    <div class="bgEnergy" aria-hidden="true">
      <div class="bgTint" :style="{ background: selectedPreset.bg }"></div>
      <div class="bgAurora a1"></div>
      <div class="bgAurora a2"></div>
      <div class="bgAurora a3"></div>
      <div class="bgGrid"></div>
      <div class="bgSparks"></div>
      <div class="bgNoise"></div>
    </div>

    <!-- SETUP -->
    <div v-if="phase === 'setup'" class="panel neonCard enter">
      <div class="title neonText">
        Triangle Arena
        <span class="modeTag">vs AI</span>
      </div>
      <div class="subtitle">Choose a board and start.</div>

      <div class="setupGrid">
        <div class="boardPicker neonCard">
          <div class="pickerTitle">
            <div class="pickerLabel neonText">Boards</div>
            <div class="pickerHint">Roll dice → draw exactly N edges → triangles auto-claim.</div>
          </div>

          <div class="presetList">
            <button
              v-for="p in BOARD_PRESETS"
              :key="p.id"
              class="presetBtn"
              :class="{ active: p.id === selectedBoardId }"
              :style="{ '--accent': p.accent, '--glow': p.glow, '--cardbg': p.bg, '--chip': p.chip }"
              @mouseenter="audio.playSfx('ui_hover', 0.5)"
              @click="loadBoard(p.id)"
            >
              <div class="presetHead">
                <div class="presetName">{{ p.name }}</div>
                <div class="presetTag">{{ p.tag }}</div>
              </div>
              <div class="presetDesc">{{ p.description }}</div>
            </button>
          </div>

          <div class="bigActions">
            <button class="btn primary neonBtn big" @click="startGame()">
              <span class="zap">🎲</span> Start Match
            </button>

            <div class="row">
              <button class="btn ghost neonBtn" @click="toggleSfx">
                {{ audio.sfxEnabled.value ? '🔊 SFX: On' : '🔇 SFX: Off' }}
              </button>
              <button class="btn ghost neonBtn" @click="toggleBgm">
                {{ audio.bgmEnabled.value ? '🎵 BGM: On' : '🚫🎵 BGM: Off' }}
              </button>
            </div>

            <div class="note">Dice is capped by what you can actually finish this turn.</div>
          </div>
        </div>

        <div class="preview neonCard">
          <div class="previewTop">
            <div class="previewTitle neonText">{{ selectedPreset.name }}</div>
            <div class="previewMeta">
              <span class="metaPill">Dots: <b>{{ board.dots.length }}</b></span>
              <span class="metaPill">Triangles: <b>{{ triangles.length }}</b></span>
              <span class="metaPill">Moves left: <b>{{ remainingLegalMovesCount }}</b></span>
            </div>
          </div>

          <div class="previewStage">
            <svg class="svg previewSvg" :viewBox="`0 0 ${board.width} ${board.height}`" preserveAspectRatio="xMidYMid meet">
              <g opacity="0.16">
                <line
                  v-for="m in allEdgesOnce"
                  :key="`pv-${m.key}`"
                  :x1="dotsById.get(m.a)!.x"
                  :y1="dotsById.get(m.a)!.y"
                  :x2="dotsById.get(m.b)!.x"
                  :y2="dotsById.get(m.b)!.y"
                  class="pvEdge"
                />
              </g>
              <g>
                <circle v-for="d in board.dots" :key="`pvd-${d.id}`" :cx="d.x" :cy="d.y" :r="7.5" class="pvDot" />
              </g>
            </svg>
          </div>

          <div class="previewFooter">
            <div class="tinyTip">Tip: Click a dot → neighbors glow → click neighbor.</div>
          </div>
        </div>
      </div>
    </div>

    <!-- PLAYING / GAMEOVER -->
    <template v-else>
      <div class="topbar neonCard enter">
        <div class="topLeft">
          <div class="titleSmall neonText">
            Triangle Arena <span class="modeTag">vs AI</span> <span class="modeTag soft">{{ selectedPreset.name }}</span>
          </div>

          <div class="hud">
            <span class="hudPill">Moves left: <b>{{ remainingLegalMovesCount }}</b></span>
            <span class="hudPill">Lines: <b>{{ linesLeft }}</b></span>
            <span class="hudPill">Rolled: <b>{{ rolled ?? '—' }}</b></span>
          </div>

          <div class="toastSlot">
            <div class="toastMsg" :class="{ show: !!message }">
              {{ message || ' ' }}
            </div>
          </div>
        </div>

        <div class="topRight">
          <div class="turnPill">
            <span class="dot" :style="{ background: currentPlayer.color, boxShadow: `0 0 18px ${currentPlayer.color}` }"></span>
            <b>{{ currentPlayer.name }}</b>
            <span v-if="currentPlayer.isAI" class="muted">(AI)</span>
          </div>

          <button class="btn ghost neonBtn" @click="resetMatch" :disabled="phase !== 'playing'">Reset</button>
          <button class="btn ghost neonBtn" @click="backToSetup">Back</button>
          <button class="btn ghost neonBtn" @click="toggleSfx">{{ audio.sfxEnabled.value ? '🔊' : '🔇' }}</button>
          <button class="btn ghost neonBtn" @click="toggleBgm">{{ audio.bgmEnabled.value ? '🎵' : '🚫🎵' }}</button>
        </div>
      </div>

      <div class="scorebar enter">
        <div v-for="p in players" :key="p.id" class="score neonCard">
          <span class="dot" :style="{ background: p.color, boxShadow: `0 0 18px ${p.color}` }"></span>
          <b class="scoreName">{{ p.name }}</b>
          <b class="scoreNum">{{ p.score }}</b>
        </div>
      </div>

      <div class="stage neonStage enter">
        <svg class="svg" :viewBox="`0 0 ${board.width} ${board.height}`" preserveAspectRatio="xMidYMid meet">
          <defs>
            <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="4.2" result="blur" />
              <feColorMatrix
                in="blur"
                type="matrix"
                values="
                  1 0 0 0 0
                  0 1 0 0 0
                  0 0 1 0 0
                  0 0 0 1.6 0"
                result="glow"
              />
              <feMerge>
                <feMergeNode in="glow" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <linearGradient id="electricGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" :stop-color="selectedPreset.accent" stop-opacity="0.10" />
              <stop offset="30%" :stop-color="selectedPreset.accent" stop-opacity="0.95" />
              <stop offset="60%" stop-color="#FF3DA6" stop-opacity="0.95" />
              <stop offset="100%" stop-color="#FF3DA6" stop-opacity="0.10" />
              <animate attributeName="x1" values="0%;100%;0%" dur="1.6s" repeatCount="indefinite" />
              <animate attributeName="x2" values="100%;0%;100%" dur="1.6s" repeatCount="indefinite" />
            </linearGradient>
          </defs>

          <g>
            <polygon
              v-for="t in triangles"
              :key="t.id"
              :points="triPoints(t)"
              :fill="playerFill(t)"
              :opacity="t.owner == null ? 0 : 0.22"
              stroke="transparent"
              filter="url(#glow)"
            />
          </g>

          <g>
            <line
              v-for="e in edges"
              :key="e.key"
              :x1="dotsById.get(e.a)!.x"
              :y1="dotsById.get(e.a)!.y"
              :x2="dotsById.get(e.b)!.x"
              :y2="dotsById.get(e.b)!.y"
              :style="{ stroke: edgeStroke(e) }"
              class="edgeLine"
              filter="url(#glow)"
            />
            <line
              v-for="e in edges"
              :key="`cur-${e.key}`"
              :x1="dotsById.get(e.a)!.x"
              :y1="dotsById.get(e.a)!.y"
              :x2="dotsById.get(e.b)!.x"
              :y2="dotsById.get(e.b)!.y"
              class="edgeCurrent"
              stroke="url(#electricGrad)"
              filter="url(#glow)"
            />
          </g>

          <g v-if="selectedDot && phase === 'playing' && !currentPlayer.isAI">
            <line
              v-for="nid in Array.from(eligibleNeighborIds)"
              :key="`hint-${selectedDot.id}-${nid}`"
              :x1="selectedDot.x"
              :y1="selectedDot.y"
              :x2="dotsById.get(nid)!.x"
              :y2="dotsById.get(nid)!.y"
              class="hintLine"
              filter="url(#glow)"
            />
          </g>

          <g>
            <circle
              v-for="d in board.dots"
              :key="d.id"
              :cx="d.x"
              :cy="d.y"
              :r="11"
              :opacity="selectedDotId == null ? 1 : d.id === selectedDotId || eligibleNeighborIds.has(d.id) ? 1 : 0.18"
              :fill="d.id === selectedDotId ? '#ffffff' : eligibleNeighborIds.has(d.id) ? selectedPreset.accent : '#C9D3E8'"
              stroke="rgba(0,0,0,0.78)"
              stroke-width="2"
              class="dotCircle"
              @click.stop="onDotClick(d.id)"
              filter="url(#glow)"
            />
          </g>
        </svg>
      </div>

      <div class="bottomDock" :class="{ locked: !canRoll }" aria-label="Dice controls">
        <div class="dockSide">
          <div class="dockStat">
            <div class="dockLabel">Lines</div>
            <div class="dockValue">{{ linesLeft }}</div>
          </div>
          <div class="dockStat">
            <div class="dockLabel">Rolled</div>
            <div class="dockValue">{{ rolled ?? '—' }}</div>
          </div>
        </div>

        <button class="diceBtn" :class="{ disabled: !canRoll, rolling: diceAnimating }" @click="canRoll && rollDice()" :title="canRollTitle">
          <div class="diceFace">
            <span v-for="(p, i) in pipMap[diceValue]" :key="i" class="pip" :style="{ transform: `translate(${p[0] * 16}px, ${p[1] * 16}px)` }" />
            <div class="diceGloss"></div>
            <div class="diceRim"></div>
          </div>

          <div class="diceCaption">
            <div class="capTop" :class="{ off: !canRoll }">{{ canRoll ? 'TAP TO ROLL' : 'WAIT…' }}</div>
            <div class="capSub">
              <span v-if="canRoll">Dice capped by feasibility</span>
              <span v-else>Finish drawing / AI turn</span>
            </div>
          </div>
        </button>

        <div class="dockSide right">
          <div class="dockStat">
            <div class="dockLabel">Moves</div>
            <div class="dockValue">{{ remainingLegalMovesCount }}</div>
          </div>
        </div>
      </div>

      <div v-if="phase === 'gameover'" class="modal">
        <div class="modalCard neonCard pop">
          <div class="modalTitle neonText">Game Over</div>
          <div class="modalSub">
            <template v-if="winners.length === 1">
              Winner: <b>{{ winners[0].name }}</b> ({{ winners[0].score }})
            </template>
            <template v-else>
              Tie: <b>{{ winners.map((w) => w.name).join(' & ') }}</b> ({{ winners[0]?.score }})
            </template>
          </div>

          <div class="modalBtns">
            <button class="btn primary neonBtn" @click="resetMatch"><span class="zap">🎉</span> Play Again</button>
            <button class="btn ghost neonBtn" @click="backToSetup">Back</button>
            <button class="btn ghost neonBtn" @click="toggleSfx">{{ audio.sfxEnabled.value ? '🔊' : '🔇' }}</button>
            <button class="btn ghost neonBtn" @click="toggleBgm">{{ audio.bgmEnabled.value ? '🎵' : '🚫🎵' }}</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style>
*,
*::before,
*::after { box-sizing: border-box; margin: 0; padding: 0; }

:root{
  --dock-h: 98px;
  --safe-b: env(safe-area-inset-bottom, 0px);
}

.wrap{
  --accent: #00F0FF;
  --glow: rgba(0,240,255,0.30);
  --cardbg: radial-gradient(900px 420px at 20% 20%, rgba(0,240,255,0.18), transparent 62%);
  --chip: rgba(0,240,255,0.12);

  min-height: 100dvh;
  color: #fff;
  padding: 16px;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  position: relative;
  overflow: hidden;
  background: #02030a;
}

/* Background */
.bgEnergy{ position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden; }
.bgTint{ position:absolute; inset: 0; opacity: 0.55; }
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
  position:absolute; inset: 0; opacity: 0.11;
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

/* subtle grain */
.bgNoise{
  position:absolute; inset: 0;
  opacity: 0.10;
  background-image:
    radial-gradient(circle at 10% 20%, rgba(255,255,255,0.24) 0 1px, transparent 2px),
    radial-gradient(circle at 70% 60%, rgba(255,255,255,0.18) 0 1px, transparent 2px),
    radial-gradient(circle at 40% 80%, rgba(255,255,255,0.14) 0 1px, transparent 2px);
  background-size: 180px 180px;
  mix-blend-mode: overlay;
  filter: blur(0.2px);
}

.wrap > *{ position: relative; z-index: 1; }
.enter{ animation: riseIn 420ms ease-out both; }
@keyframes riseIn{ from{ transform: translateY(12px); opacity: 0; } to{ transform: translateY(0); opacity: 1; } }

/* cards */
.neonCard{
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.06);
  border-radius: 18px;
  box-shadow:
    0 0 0 1px rgba(0,240,255,0.12),
    0 0 60px rgba(0,240,255,0.10),
    0 0 52px rgba(255,61,166,0.08),
    inset 0 0 26px rgba(0,0,0,0.50);
  backdrop-filter: blur(12px);
  overflow: hidden;
}
.neonText{ text-shadow: 0 0 18px rgba(0,240,255,0.34), 0 0 28px rgba(255,61,166,0.16); }

.panel{ max-width: 1100px; margin: 32px auto; padding: 18px; }
.title{ font-size: 34px; font-weight: 950; letter-spacing: -0.02em; display:flex; align-items:center; gap: 10px; }
.subtitle{ margin-top: 8px; opacity: 0.88; }

/* topbar */
.topbar{
  margin-bottom: 10px;
  padding: 14px;
  display:flex;
  align-items:flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.titleSmall{ font-size: 18px; font-weight: 950; display:flex; align-items:center; gap: 10px; flex-wrap: wrap; }

.modeTag{
  font-size: 12px; padding: 3px 8px; border-radius: 999px;
  border: 1px solid rgba(0,240,255,0.26);
  background: rgba(0,240,255,0.12);
  opacity: 0.96;
}
.modeTag.soft{ border-color: rgba(255,61,166,0.30); background: rgba(255,61,166,0.10); }

.hud{ margin-top: 8px; display:flex; gap: 10px; flex-wrap: wrap; }
.hudPill{
  display:inline-flex; gap: 8px; align-items: baseline;
  padding: 7px 11px; border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(0,0,0,0.28);
  font-size: 12px;
  color: rgba(255,255,255,0.92);
}
.hudPill b{ color:#fff; text-shadow: 0 0 14px rgba(0,240,255,0.18); }

.toastSlot{ height: 44px; margin-top: 10px; }
.toastMsg{
  height: 44px;
  display:flex;
  align-items:center;
  padding: 0 10px;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(0,0,0,0.34);
  color: rgba(255,255,255,0.96);
  font-weight: 900;
  letter-spacing: -0.01em;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 180ms ease, transform 180ms ease;
}
.toastMsg.show{ opacity: 1; transform: translateY(0); }

.topRight{ display:flex; align-items:center; gap: 10px; flex-wrap: wrap; justify-content:flex-end; }
.turnPill{
  display:inline-flex; align-items:center; gap: 8px;
  padding: 8px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(0,0,0,0.26);
  color: #fff;
  font-weight: 950;
}
.muted{ opacity: 0.72; }
.dot{ width: 12px; height: 12px; border-radius: 999px; display:inline-block; }

/* buttons */
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
.btn:disabled{ opacity: 0.55; cursor: not-allowed; }
.neonBtn{ box-shadow: 0 0 0 1px rgba(0,240,255,0.12), 0 0 18px rgba(0,240,255,0.12), 0 0 16px rgba(255,61,166,0.08); }
.btn.big{ padding: 12px 14px; border-radius: 14px; font-size: 14px; }
.zap{ filter: drop-shadow(0 0 12px rgba(0,240,255,0.34)); }

/* setup */
.setupGrid{ margin-top: 14px; display:grid; grid-template-columns: 1fr 1.1fr; gap: 12px; }
@media (max-width: 980px){ .setupGrid{ grid-template-columns: 1fr; } }
.boardPicker{ padding: 14px; }
.pickerLabel{ font-size: 16px; font-weight: 950; }
.pickerHint{ font-size: 12px; opacity: 0.82; }
.presetList{ margin-top: 12px; display:flex; flex-direction: column; gap: 10px; }

.presetBtn{
  --accent: #00F0FF;
  --glow: rgba(0,240,255,0.28);
  --cardbg: radial-gradient(900px 420px at 20% 20%, rgba(0,240,255,0.18), transparent 62%);
  --chip: rgba(0,240,255,0.12);

  width: 100%;
  text-align: left;
  border-radius: 16px;
  border: 1px solid rgba(255,255,255,0.12);
  background: var(--cardbg), rgba(255,255,255,0.06);
  color: #fff;
  padding: 12px;
  cursor: pointer;
  transition: transform 140ms ease, box-shadow 180ms ease, background 180ms ease, filter 180ms ease;
  position: relative;
  overflow: hidden;
}
.presetBtn:hover{
  transform: translateY(-1px);
  box-shadow: 0 0 0 1px rgba(255,255,255,0.10), 0 0 28px var(--glow);
  filter: brightness(1.03);
}
.presetBtn.active{
  border-color: rgba(255,255,255,0.18);
  box-shadow: 0 0 0 1px rgba(255,255,255,0.10), 0 0 30px var(--glow);
}
.presetBtn.active::after{
  content:"";
  position:absolute;
  inset: 0;
  border-radius: 16px;
  pointer-events:none;
  box-shadow: inset 0 0 0 2px var(--accent);
  opacity: 0.7;
}
.presetHead{ display:flex; align-items:center; justify-content: space-between; gap: 10px; }
.presetName{ font-weight: 1000; letter-spacing:-0.01em; }
.presetTag{
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.12);
  background: var(--chip);
  opacity: 0.95;
}
.presetDesc{ margin-top: 6px; font-size: 12px; opacity: 0.88; }

.bigActions{ margin-top: 12px; display:flex; flex-direction: column; gap: 10px; }
.row{ display:flex; gap: 10px; flex-wrap: wrap; }
.note{ font-size: 12px; opacity: 0.85; }

.preview{ padding: 14px; }
.previewTitle{ font-size: 18px; font-weight: 950; }
.previewMeta{ display:flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.metaPill{ padding: 6px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.10); background: rgba(0,0,0,0.28); font-size: 12px; opacity: 0.95; color: rgba(255,255,255,0.92); }
.metaPill b{ color:#fff; text-shadow: 0 0 14px rgba(0,240,255,0.16); }

.previewStage{
  margin-top: 12px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.10);
  background: radial-gradient(900px 520px at 50% 40%, rgba(0,240,255,0.14), transparent 60%),
              radial-gradient(900px 520px at 50% 70%, rgba(255,61,166,0.08), transparent 62%),
              rgba(0,0,0,0.34);
  overflow: hidden;
}
.previewSvg{ height: 320px; width: 100%; display:block; }
.pvEdge{ stroke: rgba(240,250,255,0.50); stroke-width: 3.0; stroke-linecap: round; stroke-dasharray: 7 16; animation: pvFlow 3.2s linear infinite; }
@keyframes pvFlow{ from{ stroke-dashoffset: 0; } to{ stroke-dashoffset: -64; } }
.pvDot{ fill: rgba(255,255,255,0.88); stroke: rgba(0,0,0,0.75); stroke-width: 2; filter: drop-shadow(0 0 10px rgba(0,240,255,0.16)); }
.previewFooter{ margin-top: 10px; }
.tinyTip{ font-size: 12px; opacity: 0.88; }

/* scorebar */
.scorebar{ display:flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.score{ display:flex; gap: 8px; align-items:center; padding: 10px 12px; border-radius: 14px; }
.scoreName{ opacity: 0.92; }
.scoreNum{ margin-left: 6px; font-size: 18px; text-shadow: 0 0 14px rgba(0,240,255,0.18), 0 0 12px rgba(255,61,166,0.10); }

/* board */
.neonStage{
  border: 1px solid rgba(255,255,255,0.12);
  background:
    radial-gradient(1100px 640px at 50% 40%, rgba(0,240,255,0.16), transparent 62%),
    radial-gradient(1100px 640px at 55% 70%, rgba(255,61,166,0.10), transparent 66%),
    radial-gradient(900px 520px at 20% 85%, rgba(120,255,70,0.06), transparent 66%),
    rgba(0,0,0,0.40);
  border-radius: 16px;
  padding: 10px;
  box-shadow: inset 0 0 34px rgba(0,0,0,0.56), 0 0 40px rgba(0,240,255,0.10), 0 0 36px rgba(255,61,166,0.08);
  position: relative;
  overflow: hidden;
  margin-bottom: calc(var(--dock-h) + var(--safe-b) + 8px);
}
/* stable stage height */
.svg{ width: 100%; height: min(72vh, 760px); display:block; }

.edgeLine{ stroke-width: 5; stroke-linecap: round; opacity: 0.95; filter: drop-shadow(0 0 14px rgba(0,240,255,0.18)); }
.edgeCurrent{ stroke-width: 3.4; stroke-linecap: round; opacity: 0.60; stroke-dasharray: 10 12; animation: currentFlow 1.0s linear infinite; mix-blend-mode: screen; }
@keyframes currentFlow{ from{ stroke-dashoffset: 0; opacity: 0.52; } to{ stroke-dashoffset: -44; opacity: 0.72; } }

.hintLine{
  stroke: rgba(255,255,255,0.85);
  stroke-width: 4;
  stroke-linecap: round;
  filter: drop-shadow(0 0 14px rgba(0,240,255,0.20));
  animation: hintPulse 1.2s ease-in-out infinite;
}
@keyframes hintPulse{ 0%,100%{ opacity: 0.28; } 50%{ opacity: 0.56; } }
.dotCircle{ cursor:pointer; transition: opacity 160ms ease, filter 160ms ease; }
.dotCircle:hover{ filter: brightness(1.14); }

/* bottom dock */
.bottomDock{
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: 12px;
  padding-bottom: calc(10px + var(--safe-b));
  padding-top: 10px;
  padding-left: 10px;
  padding-right: 10px;

  border-radius: 18px;
  border: 1px solid rgba(255,255,255,0.14);
  background:
    radial-gradient(900px 320px at 25% 20%, rgba(0,240,255,0.14), transparent 62%),
    radial-gradient(900px 320px at 75% 70%, rgba(255,61,166,0.10), transparent 66%),
    rgba(0,0,0,0.70);
  backdrop-filter: blur(14px);
  box-shadow:
    0 0 0 1px rgba(0,240,255,0.10),
    0 0 34px rgba(0,240,255,0.10),
    0 0 30px rgba(255,61,166,0.08);

  display:grid;
  grid-template-columns: 1fr auto 1fr;
  align-items:center;
  gap: 10px;

  z-index: 40;
}
@media (max-width: 520px){
  .bottomDock{
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "dice dice"
      "left right";
  }
  .dockSide{ grid-area: left; }
  .dockSide.right{ grid-area: right; justify-self: end; }
  .diceBtn{ grid-area: dice; justify-self: center; }
}

.dockSide{ display:flex; gap: 10px; align-items:center; }
.dockSide.right{ justify-content: flex-end; }

.dockStat{
  padding: 8px 10px;
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(0,0,0,0.28);
  min-width: 74px;
  text-align:center;
}
.dockLabel{
  font-size: 11px;
  opacity: 0.86;
  color: rgba(255,255,255,0.92);
}
.dockValue{
  margin-top: 2px;
  font-size: 18px;
  font-weight: 1000;
  color: #fff;
  text-shadow: 0 0 14px rgba(0,240,255,0.18);
}

.diceBtn{
  display:flex;
  align-items:center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 18px;
  border: 1px solid rgba(255,255,255,0.18);
  background: rgba(255,255,255,0.06);
  cursor: pointer;
  transition: transform 140ms ease, box-shadow 180ms ease, filter 180ms ease, background 160ms ease;
  -webkit-tap-highlight-color: transparent;
}
.diceBtn:hover{
  transform: translateY(-1px);
  background: rgba(255,255,255,0.09);
  box-shadow: 0 0 0 1px rgba(0,240,255,0.12), 0 0 22px rgba(0,240,255,0.10);
}
.diceBtn:active{ transform: translateY(0) scale(0.995); }
.diceBtn.disabled{ opacity: 0.55; cursor: not-allowed; filter: saturate(0.85); }

.diceFace{
  width: 60px; height: 60px;
  border-radius: 18px;
  position: relative;
  background: linear-gradient(180deg, rgba(255,255,255,0.92), rgba(235,240,255,0.80));
  border: 1px solid rgba(0,240,255,0.28);
  box-shadow:
    inset 0 0 18px rgba(0,0,0,0.16),
    0 10px 16px rgba(0,0,0,0.28),
    0 0 18px rgba(0,240,255,0.14),
    0 0 14px rgba(255,61,166,0.10);
  transform: rotateX(12deg) rotateY(-10deg);
}
.pip{
  width: 9px; height: 9px;
  border-radius: 999px;
  position:absolute;
  left: 50%; top: 50%;
  margin-left: -4.5px;
  margin-top: -4.5px;
  background: rgba(18,22,32,0.92);
  box-shadow: 0 0 10px rgba(0,240,255,0.16);
}
.diceGloss{
  position:absolute;
  inset: 8px 10px auto 10px;
  height: 18px;
  border-radius: 14px;
  background: linear-gradient(90deg, rgba(255,255,255,0.60), rgba(255,255,255,0.00));
  opacity: 0.9;
  pointer-events:none;
}
.diceRim{
  position:absolute; inset: 0;
  border-radius: 18px;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.22);
  pointer-events:none;
}

.diceCaption{ text-align:left; }
.capTop{
  font-size: 12px;
  font-weight: 1000;
  letter-spacing: 0.10em;
  color: var(--accent);
  text-shadow: 0 0 14px rgba(0,240,255,0.26);
}
.capTop.off{
  color: rgba(255,255,255,0.82);
  text-shadow: none;
  opacity: 0.85;
}
.capSub{
  margin-top: 2px;
  font-size: 12px;
  color: rgba(255,255,255,0.86);
}

/* Modal */
.modal{ position: fixed; inset: 0; background: rgba(0,0,0,0.62); display: grid; place-items: center; padding: 16px; z-index: 60; }
.modalCard{ width: min(520px, 100%); padding: 16px; border-radius: 18px; }
.pop{ animation: popIn 240ms ease-out both; }
@keyframes popIn{ from{ transform: scale(0.96); opacity: 0; } to{ transform: scale(1); opacity: 1; } }
.modalTitle{ font-size: 20px; font-weight: 1000; }
.modalSub{ margin-top: 6px; opacity: 0.88; }
.modalBtns{ display:flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
</style>