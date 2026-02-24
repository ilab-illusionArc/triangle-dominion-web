<!-- app/pages/play/index.vue -->
<script setup lang="ts">
useHead({ title: 'Triangle Dominion — vs AI' })

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
   SHAPE BOARDS (BACK TO BASIC + PLAYFUL)
   - We generate a triangular-lattice field
   - Then mask dots into shapes: circle, triangle, square, rectangle,
     pentagon, hexagon
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

  // recenter with padding
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

  // prune isolated
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

function polygonMask(
  field: ReturnType<typeof makeTriField>,
  sides: number,
  radiusScale = 0.84,
  rotateRad = -Math.PI / 2
) {
  const dots = field.dots
  const cx = (Math.min(...dots.map((d) => d.x)) + Math.max(...dots.map((d) => d.x))) / 2
  const cy = (Math.min(...dots.map((d) => d.y)) + Math.max(...dots.map((d) => d.y))) / 2
  const R = Math.min(field.width, field.height) * 0.35 * radiusScale

  // build polygon vertices
  const verts: { x: number; y: number }[] = []
  for (let i = 0; i < sides; i++) {
    const a = rotateRad + (i * Math.PI * 2) / sides
    verts.push({ x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R })
  }

  const inside = (px: number, py: number) => {
    // winding/ray cast
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
  return polygonMask(field, 4, 0.90, Math.PI / 4)
}
function presetRectangle() {
  const field = makeTriField({ rows: 10, cols: 16, spacing: 52, margin: 86 })
  // rectangle-ish via bounds around center
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

type BoardPreset = {
  id: string
  name: string
  tag: 'Shape'
  description: string
  build: () => { dots: Dot[]; width: number; height: number }
}

const BOARD_PRESETS: BoardPreset[] = [
  { id: 'circle', name: 'Bubble Arena', tag: 'Shape', description: 'Round and bouncy. Easy to read, fun to combo.', build: presetCircle },
  { id: 'triangle', name: 'Tri Peak', tag: 'Shape', description: 'Sharp corners, quick fights, fast endings.', build: presetTriangle },
  { id: 'square', name: 'Pixel Square', tag: 'Shape', description: 'Classic grid-ish feel, balanced edges.', build: presetSquare },
  { id: 'rectangle', name: 'Neon Strip', tag: 'Shape', description: 'Long arena—make chain captures!', build: presetRectangle },
  { id: 'pentagon', name: 'Pentagon Park', tag: 'Shape', description: 'Weird angles = playful tactics.', build: presetPentagon },
  { id: 'hexagon', name: 'Hex Hive', tag: 'Shape', description: 'Lots of options, high triangle potential.', build: presetHexagon }
]

/* =========================================================
   BOARD STATE
========================================================= */
const selectedBoardId = ref<string>('hexagon')
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

const canRoll = computed(() => {
  if (phase.value !== 'playing') return false
  if (rolled.value != null && linesLeft.value > 0) return false
  if (!currentPlayer.value) return false
  return !currentPlayer.value.isAI
})

async function rollDice() {
  if (phase.value !== 'playing') return
  if (rolled.value != null && linesLeft.value > 0) return

  const n = Math.floor(Math.random() * 6) + 1
  await animateDiceTo(n)

  linesLeft.value = n
  selectedDotId.value = null
  flash(`${currentPlayer.value.name}`)
  if (currentPlayer.value.isAI) void aiPlayTurn()
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

const recentClaimIds = ref(new Set<string>())
function markClaim(tid: string) {
  recentClaimIds.value.add(tid)
  recentClaimIds.value = new Set(recentClaimIds.value)
  window.setTimeout(() => {
    recentClaimIds.value.delete(tid)
    recentClaimIds.value = new Set(recentClaimIds.value)
  }, 520)
}

const recentEdgeKeys = ref(new Set<EdgeKey>())
function markEdge(key: EdgeKey) {
  recentEdgeKeys.value.add(key)
  recentEdgeKeys.value = new Set(recentEdgeKeys.value)
  window.setTimeout(() => {
    recentEdgeKeys.value.delete(key)
    recentEdgeKeys.value = new Set(recentEdgeKeys.value)
  }, 520)
}

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
      markClaim(t.id)
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

const moveByKey = computed(() => {
  const m = new Map<EdgeKey, Move>()
  for (const mv of allEdgesOnce.value) m.set(mv.key, mv)
  return m
})

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

function hasAnyLegalMove() {
  for (const m of allEdgesOnce.value) if (isLegalMove(m.a, m.b)) return true
  return false
}

function endGameIfNoMoves() {
  if (!hasAnyLegalMove()) {
    phase.value = 'gameover'
    rolled.value = null
    linesLeft.value = 0
    selectedDotId.value = null
    flash('Game Over')
  }
}

/* =========================================================
   TURN HELPERS
========================================================= */
async function endTurn() {
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
   SELECTION + CLICK CONNECT (YOUR REQUEST)
   - Click dot: select it and reveal neighbors
   - Click neighbor: connect line
========================================================= */
const selectedDotId = ref<number | null>(null)
const selectedDot = computed(() =>
  selectedDotId.value == null ? null : dotsById.value.get(selectedDotId.value) || null
)
const neighborIds = computed(() => new Set(selectedDot.value?.neighbors ?? []))

function onDotClick(id: number) {
  if (phase.value !== 'playing') return
  if (currentPlayer.value.isAI) return

  // No roll yet: just selection
  if (rolled.value == null || linesLeft.value <= 0) {
    selectedDotId.value = selectedDotId.value === id ? null : id
    return
  }

  // first click after roll: select
  if (selectedDotId.value == null) {
    selectedDotId.value = id
    return
  }

  const a = selectedDotId.value
  const b = id

  if (a === b) {
    selectedDotId.value = null
    return
  }

  const da = dotsById.value.get(a)
  if (!da?.neighbors.includes(b)) {
    flash('Pick a neighbor')
    selectedDotId.value = b
    return
  }

  if (hasEdge(a, b)) {
    flash('Already drawn')
    selectedDotId.value = b
    return
  }

  if (wouldCrossExistingEdge(a, b)) {
    flash("No crossing!")
    selectedDotId.value = b
    return
  }

  const ok = addEdge(a, b)
  if (!ok) return

  const key = makeEdgeKey(a, b)
  markEdge(key)

  linesLeft.value = Math.max(0, linesLeft.value - 1)

  const got = claimTrianglesForEdge(key)
  if (got > 0) flash(`🎉 +${got}`)

  selectedDotId.value = b

  if (linesLeft.value === 0) void endTurn()
}

/* =========================================================
   AI (same, slightly playful randomness)
========================================================= */
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
      Math.random() * 0.18 // more playful

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
    markEdge(move.key)
    linesLeft.value = Math.max(0, linesLeft.value - 1)

    const got = claimTrianglesForEdge(move.key)
    if (got > 0) flash(`🤖 +${got}`)
    await sleep(150)
  }

  if (phase.value === 'playing' && currentPlayer.value.isAI && linesLeft.value === 0) {
    await endTurn()
  }
}

/* =========================================================
   SETUP / RESET / SHAPE LOAD
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

function loadBoard(id: string) {
  selectedBoardId.value = id
  board.value = buildBoardById(id)
  buildTriangles()
  hardResetState()
}

function startGame() {
  players.value = [
    { id: 0, name: 'You', color: '#00F0FF', score: 0, isAI: false },
    { id: 1, name: 'AI', color: '#FF3DA6', score: 0, isAI: true }
  ]
  hardResetState()
  phase.value = 'playing'
}

function resetMatch() {
  hardResetState()
  phase.value = 'playing'
}

function backToSetup() {
  phase.value = 'setup'
  rolled.value = null
  linesLeft.value = 0
  selectedDotId.value = null
  message.value = ''
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

const selectedPreset = computed(() => BOARD_PRESETS.find((p) => p.id === selectedBoardId.value) ?? BOARD_PRESETS[0])

/* playful confetti burst on triangle claim (tiny, cheap) */
const confettiBursts = ref<Array<{ id: number; x: number; y: number; t: number; color: string }>>([])
let confId = 1
function confettiAtTriangle(t: Triangle) {
  const a = dotsById.value.get(t.a)!
  const b = dotsById.value.get(t.b)!
  const c = dotsById.value.get(t.c)!
  const x = (a.x + b.x + c.x) / 3
  const y = (a.y + b.y + c.y) / 3
  const color = playerById(t.owner)?.color ?? '#ffffff'
  confettiBursts.value.push({ id: confId++, x, y, t: performance.now(), color })
  if (confettiBursts.value.length > 14) confettiBursts.value.splice(0, confettiBursts.value.length - 14)
  window.setTimeout(() => {
    confettiBursts.value = confettiBursts.value.filter((c) => c.id !== confId - 1)
  }, 650)
}

// hook into markClaim
watch(
  () => Array.from(recentClaimIds.value),
  () => {
    // add bursts for newly claimed triangles (best effort)
    for (const tid of recentClaimIds.value) {
      const t = triangles.value.find((x) => x.id === tid)
      if (t?.owner != null) confettiAtTriangle(t)
    }
  }
)
</script>

<template>
  <div class="wrap">
    <!-- background -->
    <div class="bgEnergy">
      <div class="bgAurora a1"></div>
      <div class="bgAurora a2"></div>
      <div class="bgAurora a3"></div>
      <div class="bgGrid"></div>
      <div class="bgSparks"></div>
    </div>

    <!-- SETUP -->
    <div v-if="phase === 'setup'" class="panel neonCard enter">
      <div class="title neonText">
        Triangle Dominion
        <span class="modeTag">vs AI</span>
      </div>
      <div class="subtitle">Choose a shape board and start playing.</div>

      <div class="setupGrid">
        <div class="boardPicker neonCard">
          <div class="pickerTitle">
            <div class="pickerLabel neonText">Shapes</div>
            <div class="pickerHint">Click a dot to reveal neighbors, then click a neighbor to draw.</div>
          </div>

          <div class="presetList">
            <button
              v-for="p in BOARD_PRESETS"
              :key="p.id"
              class="presetBtn"
              :class="{ active: p.id === selectedBoardId }"
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
            <button class="btn primary neonBtn big" @click="startGame">
              <span class="zap">🎲</span> Start Match
            </button>
            <div class="note">Roll dice → draw exactly N edges → triangles auto-claim.</div>
          </div>
        </div>

        <div class="preview neonCard">
          <div class="previewTop">
            <div class="previewTitle neonText">{{ selectedPreset.name }}</div>
            <div class="previewMeta">
              <span class="metaPill">Dots: <b>{{ board.dots.length }}</b></span>
              <span class="metaPill">Triangles: <b>{{ triangles.length }}</b></span>
              <span class="metaPill">Type: <b>{{ selectedPreset.tag }}</b></span>
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
            <div class="tinyTip">Pick your vibe: circle is chill, triangle is savage 😄</div>
          </div>
        </div>
      </div>
    </div>

    <!-- PLAYING / GAMEOVER -->
    <template v-else>
      <div class="topbar neonCard enter">
        <div>
          <div class="titleSmall neonText">
            Triangle Dominion
            <span class="modeTag">vs AI</span>
            <span class="modeTag soft">{{ selectedPreset.name }}</span>
          </div>
          <div class="hud">
            <span class="hudPill"> Lines: <b class="pulseNum">{{ linesLeft }}</b> </span>
            <span class="hudPill" v-if="rolled != null"> Rolled: <b class="pulseNum">{{ rolled }}</b> </span>
          </div>
        </div>

        <div class="controls">
          <div class="pill big neonPill turnPulse">
            <span class="dot" :style="{ background: currentPlayer.color, boxShadow: `0 0 18px ${currentPlayer.color}` }"></span>
            <b>{{ currentPlayer.name }}</b>
            <span v-if="currentPlayer.isAI" class="muted">(AI)</span>
          </div>

          <!-- Dice -->
          <button
            class="diceWrap"
            :class="{ rolling: diceAnimating, settle: diceSettle, disabled: !canRoll }"
            @click="canRoll && rollDice()"
            :title="canRollTitle"
            aria-label="Roll Dice"
          >
            <div class="dice3d">
              <div class="diceFace">
                <span
                  v-for="(p, i) in pipMap[diceValue]"
                  :key="i"
                  class="pip"
                  :style="{ transform: `translate(${p[0] * 16}px, ${p[1] * 16}px)` }"
                />
                <div class="diceGloss"></div>
                <div class="diceShade"></div>
                <div class="diceRim"></div>
              </div>

              <div class="diceSide sideRight"></div>
              <div class="diceSide sideBottom"></div>
              <div class="diceShadow"></div>
            </div>
          </button>

          <button class="btn ghost neonBtn" @click="resetMatch" :disabled="phase !== 'playing'">Reset</button>
          <button class="btn ghost neonBtn" @click="backToSetup">Back</button>
        </div>
      </div>

      <div class="scorebar enter">
        <div v-for="p in players" :key="p.id" class="score neonCard scorePulse">
          <span class="dot" :style="{ background: p.color, boxShadow: `0 0 18px ${p.color}` }"></span>
          <b>{{ p.name }}</b>
          <b class="neonScore">{{ p.score }}</b>
        </div>
      </div>

      <!-- GAME BOARD -->
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
              <stop offset="0%" stop-color="#00F0FF" stop-opacity="0.10" />
              <stop offset="30%" stop-color="#00F0FF" stop-opacity="0.95" />
              <stop offset="60%" stop-color="#FF3DA6" stop-opacity="0.95" />
              <stop offset="100%" stop-color="#FF3DA6" stop-opacity="0.10" />
              <animate attributeName="x1" values="0%;100%;0%" dur="1.6s" repeatCount="indefinite" />
              <animate attributeName="x2" values="100%;0%;100%" dur="1.6s" repeatCount="indefinite" />
            </linearGradient>
          </defs>

          <!-- confetti bursts -->
          <g>
            <g v-for="c in confettiBursts" :key="c.id" class="confetti" :style="{ transform: `translate(${c.x}px, ${c.y}px)` }">
              <circle r="3.8" :fill="c.color" opacity="0.9" />
              <circle r="2.4" cx="14" cy="-6" :fill="c.color" opacity="0.7" />
              <circle r="2.6" cx="-12" cy="8" :fill="c.color" opacity="0.7" />
              <circle r="2.2" cx="8" cy="12" :fill="c.color" opacity="0.6" />
              <circle r="1.9" cx="-10" cy="-10" :fill="c.color" opacity="0.6" />
            </g>
          </g>

          <!-- Claimed triangles -->
          <g>
            <polygon
              v-for="t in triangles"
              :key="t.id"
              :points="triPoints(t)"
              :fill="playerFill(t)"
              :opacity="t.owner == null ? 0 : 0.22"
              stroke="transparent"
              :class="['triFill', recentClaimIds.has(t.id) ? 'triPop' : '']"
              filter="url(#glow)"
            />
          </g>

          <!-- Existing edges -->
          <g>
            <line
              v-for="e in edges"
              :key="e.key"
              :x1="dotsById.get(e.a)!.x"
              :y1="dotsById.get(e.a)!.y"
              :x2="dotsById.get(e.b)!.x"
              :y2="dotsById.get(e.b)!.y"
              :style="{ stroke: edgeStroke(e) }"
              :class="['edgeLine', 'electric', recentEdgeKeys.has(e.key) ? 'edgeZap' : '']"
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

          <!-- Neighbor hints (only zoom in/out animation, no moving away) -->
          <g v-if="selectedDot && phase === 'playing' && !currentPlayer.isAI">
            <line
              v-for="nid in selectedDot.neighbors"
              :key="`hint-${selectedDot.id}-${nid}`"
              :x1="selectedDot.x"
              :y1="selectedDot.y"
              :x2="dotsById.get(nid)!.x"
              :y2="dotsById.get(nid)!.y"
              :stroke="hasEdge(selectedDot.id, nid) ? 'rgba(255,255,255,0.06)' : 'rgba(0,240,255,0.55)'"
              stroke-width="4"
              stroke-linecap="round"
              class="hintLine hintPulse"
              filter="url(#glow)"
            />
          </g>

          <!-- Dots -->
          <g>
            <circle
              v-for="d in board.dots"
              :key="d.id"
              :cx="d.x"
              :cy="d.y"
              :r="11"
              :opacity="
                selectedDotId == null
                  ? 1
                  : d.id === selectedDotId || neighborIds.has(d.id)
                    ? 1
                    : 0.22
              "
              :fill="d.id === selectedDotId ? '#ffffff' : neighborIds.has(d.id) ? '#00F0FF' : '#C9D3E8'"
              stroke="rgba(0,0,0,0.78)"
              stroke-width="2"
              :class="[
                'dotCircle',
                d.id === selectedDotId ? 'dotSelected' : '',
                neighborIds.has(d.id) ? 'dotNeighbor' : ''
              ]"
              @click.stop="onDotClick(d.id)"
              filter="url(#glow)"
            />

            <circle
              v-for="d in board.dots"
              :key="`h-${d.id}`"
              :cx="d.x"
              :cy="d.y"
              :r="18"
              class="dotHalo"
              :opacity="
                selectedDotId == null
                  ? 0.10
                  : d.id === selectedDotId || neighborIds.has(d.id)
                    ? 0.20
                    : 0.05
              "
            />
          </g>
        </svg>
      </div>

      <!-- GAMEOVER MODAL -->
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
          </div>
        </div>
      </div>
    </template>
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

/* UI cards */
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
  position: relative;
  overflow: hidden;
}
.neonText{ text-shadow: 0 0 18px rgba(0,240,255,0.34), 0 0 28px rgba(255,61,166,0.16); }

.panel{ max-width: 1100px; margin: 32px auto; padding: 18px; }
.title{ font-size: 34px; font-weight: 950; letter-spacing: -0.02em; display:flex; align-items:center; gap: 10px; }
.subtitle{ margin-top: 8px; opacity: 0.88; }

.topbar{ display:flex; gap: 12px; align-items:center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 10px; padding: 14px; }
.titleSmall{ font-size: 18px; font-weight: 950; display:flex; align-items:center; gap: 10px; flex-wrap: wrap; }
.hud{ margin-top: 8px; display:flex; gap: 10px; flex-wrap: wrap; }
.hudPill{
  display:inline-flex; gap: 8px; align-items: baseline;
  padding: 7px 11px; border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(255,255,255,0.05);
  font-size: 12px; opacity: 0.92;
}
.pulseNum{ text-shadow: 0 0 18px rgba(0,240,255,0.22); animation: numPulse 1.2s ease-in-out infinite; }
@keyframes numPulse{ 0%,100%{ filter: brightness(1); } 50%{ filter: brightness(1.14); } }

.modeTag{
  font-size: 12px; padding: 3px 8px; border-radius: 999px;
  border: 1px solid rgba(0,240,255,0.26);
  background: rgba(0,240,255,0.12);
  opacity: 0.96;
}
.modeTag.soft{ border-color: rgba(255,61,166,0.30); background: rgba(255,61,166,0.10); }

.controls{ display:flex; gap: 10px; align-items:center; flex-wrap: wrap; }
.scorebar{ display:flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.score{ display:flex; gap: 8px; align-items:center; padding: 10px 12px; border-radius: 14px; }
.scorePulse{ animation: cardBreath 2.8s ease-in-out infinite; }
@keyframes cardBreath{ 0%,100%{ transform: translateY(0); } 50%{ transform: translateY(-1px); } }
.neonScore{ text-shadow: 0 0 18px rgba(0,240,255,0.22), 0 0 16px rgba(255,61,166,0.12); }

.muted{ opacity: 0.7; }
.dot{ width: 12px; height: 12px; border-radius: 999px; display:inline-block; }

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
.pill.big{ padding: 10px 12px; }
.turnPulse{ animation: turnPulse 1.3s ease-in-out infinite; }
@keyframes turnPulse{
  0%,100%{ box-shadow: 0 0 18px rgba(0,240,255,0.10); transform: translateY(0); }
  50%{ box-shadow: 0 0 28px rgba(0,240,255,0.16); transform: translateY(-1px); }
}
.neonWarn{ border-color: rgba(255,61,166,0.40); background: rgba(255,61,166,0.14); box-shadow: 0 0 18px rgba(255,61,166,0.14); }
.zapMsg{ animation: zapMsg 520ms ease-out both; }
@keyframes zapMsg{ 0%{ transform: translateY(6px); opacity: 0; } 100%{ transform: translateY(0); opacity: 1; } }
.miniZap{ filter: drop-shadow(0 0 10px rgba(255,61,166,0.40)); }

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

/* setup layout */
.setupGrid{ margin-top: 14px; display:grid; grid-template-columns: 1fr 1.1fr; gap: 12px; }
@media (max-width: 980px){ .setupGrid{ grid-template-columns: 1fr; } }
.boardPicker{ padding: 14px; }
.pickerLabel{ font-size: 16px; font-weight: 950; }
.pickerHint{ font-size: 12px; opacity: 0.82; }
.presetList{ margin-top: 12px; display:flex; flex-direction: column; gap: 10px; }
.presetBtn{
  width: 100%;
  text-align: left;
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.06);
  color: #fff;
  padding: 12px;
  cursor: pointer;
  transition: transform 140ms ease, box-shadow 180ms ease, background 180ms ease;
}
.presetBtn:hover{ transform: translateY(-1px); background: rgba(255,255,255,0.09); box-shadow: 0 0 0 1px rgba(0,240,255,0.14), 0 0 26px rgba(0,240,255,0.10); }
.presetBtn.active{ border-color: rgba(0,240,255,0.32); background: rgba(0,240,255,0.10); }
.presetHead{ display:flex; align-items:center; justify-content: space-between; gap: 10px; }
.presetName{ font-weight: 950; }
.presetTag{ font-size: 11px; padding: 3px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.24); opacity: 0.9; }
.presetDesc{ margin-top: 6px; font-size: 12px; opacity: 0.84; }
.bigActions{ margin-top: 12px; display:flex; flex-direction: column; gap: 10px; }
.note{ font-size: 12px; opacity: 0.80; }

.preview{ padding: 14px; }
.previewTitle{ font-size: 18px; font-weight: 950; }
.previewMeta{ display:flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.metaPill{ padding: 6px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.05); font-size: 12px; opacity: 0.92; }

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
.tinyTip{ font-size: 12px; opacity: 0.82; }

/* Dice */
.diceWrap{
  display:flex; align-items:center; padding: 10px; border-radius: 18px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(0,0,0,0.30);
  box-shadow: 0 0 0 1px rgba(0,240,255,0.12), 0 0 34px rgba(0,240,255,0.14), 0 0 28px rgba(255,61,166,0.10);
  cursor: pointer; transition: transform 140ms ease, box-shadow 180ms ease, filter 180ms ease;
  -webkit-tap-highlight-color: transparent; user-select: none; touch-action: manipulation;
}
.diceWrap:hover{ transform: translateY(-1px); box-shadow: 0 0 0 1px rgba(0,240,255,0.18), 0 0 46px rgba(0,240,255,0.20), 0 0 34px rgba(255,61,166,0.14); }
.diceWrap:active{ transform: translateY(0); }
.diceWrap.disabled{ opacity: 0.55; cursor: not-allowed; filter: saturate(0.85); }

.dice3d{ position: relative; width: 72px; height: 72px; perspective: 820px; display:grid; place-items:center; }
.diceShadow{ position:absolute; width: 56px; height: 18px; border-radius: 999px; bottom: 4px; filter: blur(10px); background: rgba(0,0,0,0.60); opacity: 0.55; transform: translateZ(-20px); }
.diceFace{
  width: 62px; height: 62px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.22);
  position: relative; display:grid; place-items:center; transform-style: preserve-3d;
  background: linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0.06));
  box-shadow: inset 0 0 20px rgba(0,0,0,0.55), 0 10px 18px rgba(0,0,0,0.38), 0 0 22px rgba(0,240,255,0.16), 0 0 18px rgba(255,61,166,0.10);
  transform: rotateX(14deg) rotateY(-14deg) translateZ(8px);
}
.diceSide{ position:absolute; pointer-events:none; opacity: 0.95; }
.sideRight{ width: 12px; height: 58px; right: 3px; top: 7px; border-radius: 10px; background: linear-gradient(180deg, rgba(180,190,210,0.32), rgba(20,24,34,0.55)); transform: rotateY(-72deg) translateZ(31px); }
.sideBottom{ width: 58px; height: 12px; left: 7px; bottom: 3px; border-radius: 10px; background: linear-gradient(90deg, rgba(160,170,190,0.26), rgba(14,16,22,0.62)); transform: rotateX(72deg) translateZ(31px); }
.diceRim{ position:absolute; inset: 0; border-radius: 20px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.16), inset 0 0 16px rgba(0,0,0,0.28); pointer-events:none; }
.diceGloss{ position:absolute; inset: 7px 9px auto 9px; height: 20px; border-radius: 14px; background: linear-gradient(90deg, rgba(255,255,255,0.42), rgba(255,255,255,0.00)); opacity: 0.95; pointer-events: none; }
.diceShade{ position:absolute; inset: auto 6px 6px 6px; height: 16px; border-radius: 14px; background: radial-gradient(80px 30px at 40% 0%, rgba(0,0,0,0), rgba(0,0,0,0.35)); opacity: 0.92; pointer-events:none; }
.pip{ width: 9px; height: 9px; border-radius: 999px; background: rgba(245,252,255,0.96); position: absolute; box-shadow: 0 0 14px rgba(0,240,255,0.38); }

/* Board */
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
}
.svg{ width: 100%; height: 75vh; display:block; }

/* edges */
.edgeLine{ stroke-width: 5; stroke-linecap: round; opacity: 0.95; filter: drop-shadow(0 0 14px rgba(0,240,255,0.18)); }
.edgeCurrent{ stroke-width: 3.4; stroke-linecap: round; opacity: 0.60; stroke-dasharray: 10 12; animation: currentFlow 1.0s linear infinite; mix-blend-mode: screen; }
@keyframes currentFlow{ from{ stroke-dashoffset: 0; opacity: 0.52; } to{ stroke-dashoffset: -44; opacity: 0.72; } }
.edgeLine.electric{ stroke-dasharray: 12 10; animation: edgeShiver 1.45s ease-in-out infinite; }
@keyframes edgeShiver{ 0%,100%{ stroke-dashoffset: 0; filter: brightness(1); } 50%{ stroke-dashoffset: -22; filter: brightness(1.12); } }
.edgeZap{ animation: edgeZap 520ms ease-out both; }
@keyframes edgeZap{ 0%{ stroke-width: 1; opacity: 0.25; filter: brightness(1.5); } 45%{ stroke-width: 6.6; opacity: 1; filter: brightness(1.25); } 100%{ stroke-width: 5; opacity: 0.95; filter: brightness(1); } }

/* triangles */
.triFill{ transform-box: fill-box; transform-origin: center; transition: opacity 180ms ease; }
.triPop{ animation: triPop 520ms cubic-bezier(.18,.9,.18,1.02); filter: drop-shadow(0 0 20px rgba(0,240,255,0.20)); }
@keyframes triPop{ 0%{ transform: scale(0.86); opacity: 0.06; } 36%{ transform: scale(1.12); opacity: 0.30; } 100%{ transform: scale(1.00); opacity: 0.22; } }

/* neighbor hint: ONLY zoom in/out */
.hintLine{ filter: drop-shadow(0 0 14px rgba(0,240,255,0.20)); transform-origin: center; }
.hintPulse{ animation: hintZoom 0.9s ease-in-out infinite; }
@keyframes hintZoom{ 0%,100%{ transform: scale(1); opacity: 0.42; } 50%{ transform: scale(1.06); opacity: 0.66; } }

/* dots: ONLY zoom in/out */
.dotCircle{ cursor:pointer; transition: opacity 160ms ease, filter 160ms ease; transform-origin: center; }
.dotSelected{ animation: dotZoomSel 0.9s ease-in-out infinite; }
@keyframes dotZoomSel{
  0%,100%{ transform: scale(1.06); filter: brightness(1.25) drop-shadow(0 0 24px rgba(0,240,255,0.26)); }
  50%{ transform: scale(1.12); filter: brightness(1.35) drop-shadow(0 0 30px rgba(0,240,255,0.34)); }
}
.dotNeighbor{ animation: dotZoomNb 1.1s ease-in-out infinite; }
@keyframes dotZoomNb{
  0%,100%{ transform: scale(1.02); filter: brightness(1.18) drop-shadow(0 0 18px rgba(0,240,255,0.22)); }
  50%{ transform: scale(1.08); filter: brightness(1.28) drop-shadow(0 0 24px rgba(0,240,255,0.30)); }
}

.dotHalo{
  fill: transparent;
  stroke: rgba(0,240,255,0.12);
  stroke-width: 2;
  stroke-dasharray: 14 14;
  animation: haloSpin 2.4s linear infinite;
  filter: blur(0.2px);
  pointer-events:none;
}
@keyframes haloSpin{ from{ stroke-dashoffset: 0; opacity: 0.10; } to{ stroke-dashoffset: -56; opacity: 0.24; } }

/* confetti */
.confetti{ animation: confPop 650ms ease-out both; transform-origin: center; }
@keyframes confPop{
  0%{ opacity: 0; transform: translate(0,0) scale(0.6); }
  45%{ opacity: 1; transform: translate(0,-10px) scale(1); }
  100%{ opacity: 0; transform: translate(0,-22px) scale(1.05); }
}

/* Modal */
.modal{ position: fixed; inset: 0; background: rgba(0,0,0,0.62); display: grid; place-items: center; padding: 16px; z-index: 50; }
.modalCard{ width: min(520px, 100%); padding: 16px; border-radius: 18px; }
.pop{ animation: popIn 240ms ease-out both; }
@keyframes popIn{ from{ transform: scale(0.96); opacity: 0; } to{ transform: scale(1); opacity: 1; } }
.modalTitle{ font-size: 20px; font-weight: 1000; }
.modalSub{ margin-top: 6px; opacity: 0.88; }
.modalBtns{ display:flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
</style>