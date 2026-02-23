<!-- app/pages/play.vue -->
<script setup lang="ts">
useHead({ title: 'Triangle Dominion — vs AI' })

type Dot = { id: number; x: number; y: number; neighbors: number[] }
type EdgeKey = string
type Edge = { a: number; b: number; key: EdgeKey }

type Player = { id: number; name: string; color: string; score: number; isAI?: boolean }
type Triangle = {
  id: string
  a: number
  b: number
  c: number
  edges: [EdgeKey, EdgeKey, EdgeKey]
  owner: number | null
}

type Phase = 'setup' | 'playing' | 'gameover'

/* ---------------- Utils ---------------- */
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

/* ---------------- Board generation (triangular lattice) ---------------- */
function makeTriBoard(opts?: { rows?: number; cols?: number; spacing?: number; margin?: number }) {
  const rows = opts?.rows ?? 8
  const cols = opts?.cols ?? 9
  const s = opts?.spacing ?? 60
  const m = opts?.margin ?? 60

  const rowDy = Math.sin(Math.PI / 3) * s
  const idx = (r: number, c: number) => r * cols + c

  const dots: { id: number; x: number; y: number }[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = m + c * s + (r % 2 ? s / 2 : 0)
      const y = m + r * rowDy
      dots.push({ id: idx(r, c), x, y })
    }
  }

  const neighborSet = new Map<number, Set<number>>()
  const add = (a: number, b: number) => {
    if (a === b) return
    if (a < 0 || b < 0) return
    if (a >= rows * cols || b >= rows * cols) return
    if (!neighborSet.get(a)) neighborSet.set(a, new Set())
    neighborSet.get(a)!.add(b)
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = idx(r, c)

      // left/right
      if (c - 1 >= 0) add(a, idx(r, c - 1))
      if (c + 1 < cols) add(a, idx(r, c + 1))

      // diagonals based on row parity
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

  const full: Dot[] = dots.map((d) => ({
    ...d,
    neighbors: Array.from(neighborSet.get(d.id) ?? []).sort((a, b) => a - b)
  }))

  const maxX = Math.max(...full.map((d) => d.x)) + m
  const maxY = Math.max(...full.map((d) => d.y)) + m
  return { dots: full, width: maxX, height: maxY, rows, cols, spacing: s, margin: m }
}

/* ---------------- Board state ---------------- */
const board = ref(makeTriBoard({ rows: 8, cols: 9, spacing: 60, margin: 60 }))
const dotsById = computed(() => {
  const m = new Map<number, Dot>()
  for (const d of board.value.dots) m.set(d.id, d)
  return m
})

/* ---------------- Phase ---------------- */
const phase = ref<Phase>('setup')

/* ---------------- Players ---------------- */
const players = ref<Player[]>([])
const currentPlayerIndex = ref(0)
const currentPlayer = computed(() => players.value[currentPlayerIndex.value])

/* ---------------- Dice / Turn state ---------------- */
const rolled = ref<number | null>(null)
const linesLeft = ref(0)
const message = ref('')
const diceAnimating = ref(false)

function flash(msg: string) {
  message.value = msg
  window.clearTimeout((flash as any)._t)
  ;(flash as any)._t = window.setTimeout(() => (message.value = ''), 1100)
}

/* ---------------- Edge state ---------------- */
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
  edges.value.push({ a: Math.min(a, b), b: Math.max(a, b), key })
  return true
}

/* ---------------- No-crossing geometry ---------------- */
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

/* ---------------- Triangles precompute + claim ---------------- */
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
buildTriangles()

// triangle pop animation
const recentClaimIds = ref(new Set<string>())
function markClaim(tid: string) {
  recentClaimIds.value.add(tid)
  recentClaimIds.value = new Set(recentClaimIds.value)
  window.setTimeout(() => {
    recentClaimIds.value.delete(tid)
    recentClaimIds.value = new Set(recentClaimIds.value)
  }, 420)
}

function claimTrianglesForEdge(edgeKey: EdgeKey) {
  const list = triByEdge.value.get(edgeKey) ?? []
  let claimed = 0
  for (const t of list) {
    if (t.owner != null) continue
    const [e1, e2, e3] = t.edges
    if (edgeExists(e1) && edgeExists(e2) && edgeExists(e3)) {
      t.owner = currentPlayer.value.id
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

/* ---------------- Legal moves ---------------- */
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
  for (const m of allEdgesOnce.value) {
    if (isLegalMove(m.a, m.b)) return true
  }
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

/* ---------------- Dice UI ---------------- */
const pipMap: Record<number, Array<[number, number]>> = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]]
}
const diceValue = computed(() => rolled.value ?? 1)

// small “settle” bump when roll ends (more real)
const diceSettle = ref(false)

async function animateDiceTo(finalValue: number) {
  diceAnimating.value = true
  diceSettle.value = false

  const ticks = 14
  for (let i = 0; i < ticks; i++) {
    rolled.value = Math.floor(Math.random() * 6) + 1
    await sleep(18 + i * 9)
  }

  rolled.value = finalValue
  diceAnimating.value = false

  // settle kick
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

/* ---------------- Turn helpers ---------------- */
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

/* ---------------- Selection + interaction ---------------- */
const selectedDotId = ref<number | null>(null)
const selectedDot = computed(() =>
  selectedDotId.value == null ? null : dotsById.value.get(selectedDotId.value) || null
)
const neighborIds = computed(() => new Set(selectedDot.value?.neighbors ?? []))

function onDotClick(id: number) {
  if (phase.value !== 'playing') return
  if (currentPlayer.value.isAI) return

  if (rolled.value == null || linesLeft.value <= 0) {
    selectedDotId.value = selectedDotId.value === id ? null : id
    return
  }

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
    flash('Pick a neighboring dot')
    selectedDotId.value = b
    return
  }

  if (hasEdge(a, b)) {
    flash('Already drawn')
    selectedDotId.value = b
    return
  }

  if (wouldCrossExistingEdge(a, b)) {
    flash("Illegal: lines can't cross")
    selectedDotId.value = b
    return
  }

  const ok = addEdge(a, b)
  if (!ok) {
    flash('Failed to add edge')
    selectedDotId.value = b
    return
  }

  linesLeft.value = Math.max(0, linesLeft.value - 1)

  const got = claimTrianglesForEdge(makeEdgeKey(a, b))
  if (got > 0) flash(`+${got}`)

  selectedDotId.value = b

  if (linesLeft.value === 0) void endTurn()
}

/* ---------------- Smarter AI (triangle-building) ---------------- */
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
  const norm = 1 - clamp(dist / Math.max(board.value.width, board.value.height), 0, 1)
  return norm
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

    const setupWeight = afterLines > 0 ? 650 : 40
    const dangerWeight = afterLines > 0 ? 110 : 620

    const oppBest = opponentBestImmediateAfter(m.key)
    const oppWeight = afterLines > 0 ? 160 : 650

    const center = edgeCenterBonus(m.a, m.b)

    const score =
      immediate * 5000 +
      setup * setupWeight -
      danger * dangerWeight -
      oppBest * oppWeight +
      center * 20 +
      Math.random() * 0.08

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

  await sleep(180)

  while (linesLeft.value > 0 && phase.value === 'playing' && currentPlayer.value.isAI) {
    const move = pickAIMoveWise(linesLeft.value)
    if (!move) {
      endGameIfNoMoves()
      break
    }

    addEdge(move.a, move.b)
    linesLeft.value = Math.max(0, linesLeft.value - 1)

    claimTrianglesForEdge(move.key)
    await sleep(150)
  }

  if (phase.value === 'playing' && currentPlayer.value.isAI && linesLeft.value === 0) {
    await endTurn()
  }
}

/* ---------------- Setup / Reset ---------------- */
async function startGame() {
  players.value = [
    { id: 0, name: 'You', color: '#00F0FF', score: 0, isAI: false },
    { id: 1, name: 'AI', color: '#FF3DA6', score: 0, isAI: true }
  ]

  edges.value = []
  edgeSet.value = new Set()
  rolled.value = null
  linesLeft.value = 0
  selectedDotId.value = null
  message.value = ''
  currentPlayerIndex.value = 0

  for (const t of triangles.value) t.owner = null
  for (const p of players.value) p.score = 0

  phase.value = 'playing'
}

async function resetMatch() {
  edges.value = []
  edgeSet.value = new Set()
  rolled.value = null
  linesLeft.value = 0
  selectedDotId.value = null
  message.value = ''
  currentPlayerIndex.value = 0
  for (const t of triangles.value) t.owner = null
  for (const p of players.value) p.score = 0
  phase.value = 'playing'
}

function backToSetup() {
  phase.value = 'setup'
  rolled.value = null
  linesLeft.value = 0
  selectedDotId.value = null
  message.value = ''
}

/* ---------------- Winner ---------------- */
const winners = computed(() => {
  if (phase.value !== 'gameover') return []
  const max = Math.max(...players.value.map((p) => p.score))
  return players.value.filter((p) => p.score === max)
})

/* ---------------- Render helpers ---------------- */
function playerFill(t: Triangle) {
  return playerById(t.owner)?.color ?? 'transparent'
}

/* ---------------- Dice click behaviour ---------------- */
const canRollTitle = computed(() => (canRoll.value ? 'Roll' : ''))
</script>

<template>
  <div class="wrap">
    <!-- SETUP -->
    <div v-if="phase === 'setup'" class="panel neonCard enter">
      <div class="title neonText">Triangle Dominion</div>
      <div class="subtitle">vs AI</div>

      <div class="cardInner">
        <button class="btn primary neonBtn" @click="startGame">Start</button>
        <div class="note">Click dice to roll → draw lines → claim triangles.</div>
      </div>
    </div>

    <!-- PLAYING / GAMEOVER -->
    <template v-else>
      <div class="topbar neonCard enter">
        <div>
          <div class="titleSmall neonText">
            Triangle Dominion <span class="modeTag">vs AI</span>
          </div>
          <div class="hud">
            <span class="hudPill">
              Lines: <b>{{ linesLeft }}</b>
            </span>
            <span class="hudPill" v-if="rolled != null">
              Rolled: <b>{{ rolled }}</b>
            </span>
          </div>
        </div>

        <div class="controls">
          <div class="pill big neonPill">
            <span
              class="dot"
              :style="{ background: currentPlayer.color, boxShadow: `0 0 16px ${currentPlayer.color}` }"
            ></span>
            <b>{{ currentPlayer.name }}</b>
            <span v-if="currentPlayer.isAI" class="muted">(AI)</span>
          </div>

          <!-- Dice (more real 3D vibe while rolling) -->
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

          <div v-if="message" class="pill warn neonWarn">{{ message }}</div>
        </div>
      </div>

      <div class="scorebar enter">
        <div v-for="p in players" :key="p.id" class="score neonCard">
          <span class="dot" :style="{ background: p.color, boxShadow: `0 0 16px ${p.color}` }"></span>
          <b>{{ p.name }}</b>
          <b class="neonScore">{{ p.score }}</b>
        </div>
      </div>

      <!-- GAME BOARD -->
      <div class="stage neonStage enter">
        <svg class="svg" :viewBox="`0 0 ${board.width} ${board.height}`" preserveAspectRatio="xMidYMid meet">
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
              class="edgeLine"
            />
          </g>

          <!-- Neighbor hints -->
          <g v-if="selectedDot && phase === 'playing' && !currentPlayer.isAI">
            <line
              v-for="nid in selectedDot.neighbors"
              :key="`hint-${selectedDot.id}-${nid}`"
              :x1="selectedDot.x"
              :y1="selectedDot.y"
              :x2="dotsById.get(nid)!.x"
              :y2="dotsById.get(nid)!.y"
              :stroke="hasEdge(selectedDot.id, nid) ? 'rgba(255,255,255,0.08)' : 'rgba(0,240,255,0.32)'"
              stroke-width="4"
              stroke-linecap="round"
              class="hintLine"
            />
          </g>

          <!-- Dots (NO SHAKE / NO HOVER SCALE) -->
          <g>
            <circle
              v-for="d in board.dots"
              :key="d.id"
              :cx="d.x"
              :cy="d.y"
              :r="10"
              :opacity="
                selectedDotId == null
                  ? 1
                  : d.id === selectedDotId || neighborIds.has(d.id)
                    ? 1
                    : 0.22
              "
              :fill="d.id === selectedDotId ? '#ffffff' : neighborIds.has(d.id) ? '#00F0FF' : '#C9D3E8'"
              stroke="rgba(0,0,0,0.70)"
              stroke-width="2"
              class="dotCircle"
              @click="onDotClick(d.id)"
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
            <button class="btn primary neonBtn" @click="resetMatch">Play Again</button>
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
  background:
    radial-gradient(1200px 700px at 14% 12%, rgba(0,240,255,0.22), transparent 55%),
    radial-gradient(980px 650px at 86% 18%, rgba(255,61,166,0.18), transparent 58%),
    radial-gradient(1100px 800px at 55% 92%, rgba(120,255,70,0.12), transparent 60%),
    radial-gradient(900px 650px at 50% 48%, rgba(120,90,255,0.10), transparent 60%),
    #03040a;
  color: #fff;
  padding: 16px;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
}

.enter{ animation: riseIn 420ms ease-out both; }
@keyframes riseIn{
  from{ transform: translateY(10px); opacity: 0; }
  to{ transform: translateY(0); opacity: 1; }
}

.neonCard{
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.06);
  border-radius: 18px;
  box-shadow:
    0 0 0 1px rgba(0,240,255,0.12),
    0 0 42px rgba(0,240,255,0.09),
    0 0 40px rgba(255,61,166,0.06),
    inset 0 0 26px rgba(0,0,0,0.42);
  backdrop-filter: blur(12px);
}

.neonText{
  text-shadow:
    0 0 18px rgba(0,240,255,0.30),
    0 0 28px rgba(255,61,166,0.12);
}

.panel{ max-width: 760px; margin: 40px auto; padding: 18px; }
.title{ font-size: 34px; font-weight: 950; letter-spacing: -0.02em; }
.subtitle{ margin-top: 6px; opacity: 0.85; }
.cardInner{ margin-top: 14px; display:flex; flex-direction: column; gap: 12px; }
.note{ font-size: 12px; opacity: 0.78; }

.topbar{ display:flex; gap: 12px; align-items:center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 10px; padding: 14px; }
.titleSmall{ font-size: 18px; font-weight: 950; }

.hud{ margin-top: 8px; display:flex; gap: 10px; flex-wrap: wrap; }
.hudPill{
  display:inline-flex;
  gap: 8px;
  align-items: baseline;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(255,255,255,0.05);
  font-size: 12px;
  opacity: 0.9;
}
.hudPill b{ text-shadow: 0 0 16px rgba(0,240,255,0.16); }

.modeTag{
  margin-left: 8px;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid rgba(0,240,255,0.26);
  background: rgba(0,240,255,0.10);
  opacity: 0.96;
}

.controls{ display:flex; gap: 10px; align-items:center; flex-wrap: wrap; }
.scorebar{ display:flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.score{ display:flex; gap: 8px; align-items:center; padding: 10px 12px; border-radius: 14px; }
.neonScore{
  text-shadow:
    0 0 18px rgba(0,240,255,0.22),
    0 0 16px rgba(255,61,166,0.10);
}

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
  transition: transform 120ms ease, box-shadow 160ms ease, background 160ms ease;
}
.btn:hover{ background: rgba(255,255,255,0.14); transform: translateY(-1px); }
.btn:active{ transform: translateY(0) scale(0.99); }
.btn.ghost{ background: transparent; }
.btn.primary{ background: rgba(0,240,255,0.14); border-color: rgba(0,240,255,0.30); }
.btn:disabled{ opacity: 0.45; cursor: not-allowed; }
.neonBtn{
  box-shadow:
    0 0 0 1px rgba(0,240,255,0.10),
    0 0 18px rgba(0,240,255,0.10),
    0 0 16px rgba(255,61,166,0.06);
}
.neonBtn:hover{
  box-shadow:
    0 0 0 1px rgba(0,240,255,0.16),
    0 0 28px rgba(0,240,255,0.14),
    0 0 22px rgba(255,61,166,0.10);
}

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
.neonPill{ box-shadow: 0 0 18px rgba(0,240,255,0.06); }
.pill.big{ padding: 10px 12px; }
.neonWarn{
  border-color: rgba(255,61,166,0.35);
  background: rgba(255,61,166,0.12);
  box-shadow: 0 0 18px rgba(255,61,166,0.10);
}

/* ---------------- Dice (more REAL 3D vibe) ---------------- */
.diceWrap{
  display:flex;
  align-items:center;
  padding: 10px;
  border-radius: 18px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(0,0,0,0.28);
  box-shadow:
    0 0 0 1px rgba(0,240,255,0.10),
    0 0 28px rgba(0,240,255,0.12),
    0 0 22px rgba(255,61,166,0.07);
  cursor: pointer;
  transition: transform 140ms ease, box-shadow 180ms ease, filter 180ms ease;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  touch-action: manipulation;
}
.diceWrap:hover{
  transform: translateY(-1px);
  box-shadow:
    0 0 0 1px rgba(0,240,255,0.16),
    0 0 38px rgba(0,240,255,0.18),
    0 0 30px rgba(255,61,166,0.12);
}
.diceWrap:active{ transform: translateY(0); }
.diceWrap.disabled{ opacity: 0.55; cursor: not-allowed; filter: saturate(0.85); }

.dice3d{
  position: relative;
  width: 72px;
  height: 72px;
  perspective: 820px;
  display:grid;
  place-items:center;
}
.diceShadow{
  position:absolute;
  width: 56px;
  height: 18px;
  border-radius: 999px;
  bottom: 4px;
  filter: blur(10px);
  background: rgba(0,0,0,0.60);
  opacity: 0.55;
  transform: translateZ(-20px);
}

.diceFace{
  width: 62px;
  height: 62px;
  border-radius: 20px;
  border: 1px solid rgba(255,255,255,0.22);
  position: relative;
  display:grid;
  place-items:center;
  transform-style: preserve-3d;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0.06));
  box-shadow:
    inset 0 0 20px rgba(0,0,0,0.55),
    0 10px 18px rgba(0,0,0,0.38),
    0 0 22px rgba(0,240,255,0.14),
    0 0 18px rgba(255,61,166,0.08);
  transform: rotateX(14deg) rotateY(-14deg) translateZ(8px);
}

.diceSide{
  position:absolute;
  pointer-events:none;
  opacity: 0.95;
  filter: blur(0px);
}
.sideRight{
  width: 12px;
  height: 58px;
  right: 3px;
  top: 7px;
  border-radius: 10px;
  background: linear-gradient(180deg, rgba(180,190,210,0.32), rgba(20,24,34,0.55));
  transform: rotateY(-72deg) translateZ(31px);
  box-shadow: inset 0 0 10px rgba(0,0,0,0.35);
}
.sideBottom{
  width: 58px;
  height: 12px;
  left: 7px;
  bottom: 3px;
  border-radius: 10px;
  background: linear-gradient(90deg, rgba(160,170,190,0.26), rgba(14,16,22,0.62));
  transform: rotateX(72deg) translateZ(31px);
  box-shadow: inset 0 0 10px rgba(0,0,0,0.35);
}

.diceRim{
  position:absolute;
  inset: 0;
  border-radius: 20px;
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,0.16),
    inset 0 0 16px rgba(0,0,0,0.28);
  pointer-events:none;
}
.diceGloss{
  position:absolute;
  inset: 7px 9px auto 9px;
  height: 20px;
  border-radius: 14px;
  background: linear-gradient(90deg, rgba(255,255,255,0.42), rgba(255,255,255,0.00));
  opacity: 0.95;
  pointer-events: none;
}
.diceShade{
  position:absolute;
  inset: auto 6px 6px 6px;
  height: 16px;
  border-radius: 14px;
  background: radial-gradient(80px 30px at 40% 0%, rgba(0,0,0,0), rgba(0,0,0,0.35));
  opacity: 0.92;
  pointer-events:none;
}

.pip{
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: rgba(245,252,255,0.96);
  position: absolute;
  box-shadow: 0 0 14px rgba(0,240,255,0.35);
}

/* rolling: faster spin + hard perspective wobble + motion blur illusion */
.diceWrap.rolling .diceFace{
  animation: diceRollFace 520ms ease-in-out infinite;
  filter: saturate(1.18) brightness(1.12);
}
.diceWrap.rolling .sideRight{ animation: diceRollSideR 520ms ease-in-out infinite; }
.diceWrap.rolling .sideBottom{ animation: diceRollSideB 520ms ease-in-out infinite; }
.diceWrap.rolling .diceShadow{ animation: shadowPulse 520ms ease-in-out infinite; }
.diceWrap.rolling .pip{ opacity: 0.78; filter: blur(0.35px); }

@keyframes diceRollFace{
  0%   { transform: rotateX(10deg)  rotateY(-12deg) rotateZ(0deg)   translateZ(8px); }
  20%  { transform: rotateX(150deg) rotateY(40deg)  rotateZ(65deg)  translateZ(14px); }
  45%  { transform: rotateX(260deg) rotateY(210deg) rotateZ(120deg) translateZ(8px); }
  70%  { transform: rotateX(110deg) rotateY(330deg) rotateZ(170deg) translateZ(14px); }
  100% { transform: rotateX(370deg) rotateY(380deg) rotateZ(210deg) translateZ(8px); }
}
@keyframes diceRollSideR{
  0%{ opacity: 0.85; filter: brightness(1.00); }
  50%{ opacity: 0.65; filter: brightness(0.92); }
  100%{ opacity: 0.85; filter: brightness(1.00); }
}
@keyframes diceRollSideB{
  0%{ opacity: 0.78; filter: brightness(0.98); }
  50%{ opacity: 0.62; filter: brightness(0.90); }
  100%{ opacity: 0.78; filter: brightness(0.98); }
}
@keyframes shadowPulse{
  0%{ transform: scale(1) translateZ(-20px); opacity: 0.52; }
  50%{ transform: scale(0.78) translateZ(-20px); opacity: 0.34; }
  100%{ transform: scale(1) translateZ(-20px); opacity: 0.52; }
}

/* settle: small bounce & snap */
.diceWrap.settle .dice3d{ animation: settle 240ms ease-out; }
@keyframes settle{
  0%{ transform: translateY(-2px) scale(1.02); }
  65%{ transform: translateY(1px) scale(0.995); }
  100%{ transform: translateY(0) scale(1); }
}

/* Board */
.neonStage{
  border: 1px solid rgba(255,255,255,0.12);
  background:
    radial-gradient(900px 520px at 50% 40%, rgba(0,240,255,0.10), transparent 60%),
    radial-gradient(900px 520px at 50% 70%, rgba(255,61,166,0.05), transparent 62%),
    rgba(0,0,0,0.38);
  border-radius: 16px;
  padding: 10px;
  box-shadow:
    inset 0 0 30px rgba(0,0,0,0.52),
    0 0 34px rgba(0,240,255,0.08),
    0 0 30px rgba(255,61,166,0.06);
}
.svg{ width: 100%; height: 75vh; display:block; }

.edgeLine{
  stroke: rgba(240,250,255,0.90);
  stroke-width: 5;
  stroke-linecap: round;
  filter: drop-shadow(0 0 12px rgba(0,240,255,0.18));
}

/* Triangle claim pop */
.triFill{
  transform-box: fill-box;
  transform-origin: center;
  transition: opacity 180ms ease;
}
.triPop{
  animation: triPop 420ms ease-out;
  filter: drop-shadow(0 0 18px rgba(0,240,255,0.18));
}
@keyframes triPop{
  0%{ transform: scale(0.92); opacity: 0.08; }
  40%{ transform: scale(1.08); opacity: 0.28; }
  100%{ transform: scale(1.00); opacity: 0.22; }
}

.hintLine{ filter: drop-shadow(0 0 12px rgba(0,240,255,0.14)); }

/* Dots: stable (no hover scale, no shake) */
.dotCircle{
  cursor:pointer;
  filter: drop-shadow(0 0 12px rgba(0,240,255,0.14));
  transition: opacity 160ms ease;
}

/* Modal */
.modal{
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.62);
  display: grid;
  place-items: center;
  padding: 16px;
}
.modalCard{ width: min(520px, 100%); padding: 16px; border-radius: 18px; }
.pop{ animation: popIn 240ms ease-out both; }
@keyframes popIn{
  from{ transform: scale(0.96); opacity: 0; }
  to{ transform: scale(1); opacity: 1; }
}
.modalTitle{ font-size: 20px; font-weight: 1000; }
.modalSub{ margin-top: 6px; opacity: 0.88; }
.modalBtns{ display:flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
</style>