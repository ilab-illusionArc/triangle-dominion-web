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
   GEOJSON -> DOT MAP (REAL CITY OUTLINES)
   - Fetch boundary GeoJSON (Polygon / MultiPolygon)
   - Project lat/lon into local XY
   - Sample points inside polygon (Poisson-ish rejection)
   - Build neighbor graph by radius + K nearest
========================================================= */
type LonLat = [number, number]
type PolygonLL = LonLat[] // ring
type MultiPolyLL = PolygonLL[] // multiple rings (we use outer ring only per polygon)

function bboxOf(points: LonLat[]) {
  let minLon = Infinity,
      minLat = Infinity,
      maxLon = -Infinity,
      maxLat = -Infinity
  for (const [lon, lat] of points) {
    if (lon < minLon) minLon = lon
    if (lat < minLat) minLat = lat
    if (lon > maxLon) maxLon = lon
    if (lat > maxLat) maxLat = lat
  }
  return { minLon, minLat, maxLon, maxLat }
}

// equirectangular projection (good enough for city scale)
function project(lon: number, lat: number, midLat: number) {
  const rad = Math.PI / 180
  const x = lon * Math.cos(midLat * rad)
  const y = lat
  return { x, y }
}

// Ray casting point-in-polygon (for projected coordinates)
function pointInPoly(px: number, py: number, poly: { x: number; y: number }[]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
        yi = poly[i].y
    const xj = poly[j].x,
        yj = poly[j].y
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function simplifyRing(ring: LonLat[], step = 3) {
  // very light simplification to reduce work
  const out: LonLat[] = []
  for (let i = 0; i < ring.length; i += step) out.push(ring[i])
  // ensure closed-ish
  if (out.length >= 3) out.push(out[0])
  return out
}

function extractOuterRingsFromGeoJSON(geo: any): MultiPolyLL {
  // returns list of outer rings (each ring is LonLat[])
  // Supports:
  // - FeatureCollection
  // - Feature (Polygon/MultiPolygon)
  // - Geometry (Polygon/MultiPolygon)
  const rings: MultiPolyLL = []

  function handleGeom(g: any) {
    if (!g) return
    if (g.type === 'Polygon') {
      // coordinates: [ [ring...], [holes...], ...]
      if (Array.isArray(g.coordinates?.[0])) rings.push(g.coordinates[0] as LonLat[])
    } else if (g.type === 'MultiPolygon') {
      // coordinates: [ Polygon[], ... ] ; each Polygon: [ [outer], [holes]... ]
      for (const poly of g.coordinates ?? []) {
        if (Array.isArray(poly?.[0])) rings.push(poly[0] as LonLat[])
      }
    }
  }

  if (geo.type === 'FeatureCollection') {
    for (const f of geo.features ?? []) handleGeom(f.geometry)
  } else if (geo.type === 'Feature') {
    handleGeom(geo.geometry)
  } else {
    handleGeom(geo)
  }

  // Filter tiny rings
  return rings.filter((r) => (r?.length ?? 0) >= 8)
}

function buildDotsFromOutline(
    outerRing: LonLat[],
    opts?: { dotCount?: number; minDist?: number; maxK?: number; pad?: number }
) {
  const dotCount = opts?.dotCount ?? 90
  const minDist = opts?.minDist ?? 0.012 // in projected bbox-relative units (we re-scale later)
  const maxK = opts?.maxK ?? 7
  const padPx = opts?.pad ?? 80

  // simplify ring to speed
  const ring = simplifyRing(outerRing, 3)

  // bbox & projection
  const bb = bboxOf(ring)
  const midLat = (bb.minLat + bb.maxLat) / 2

  const projRing = ring.map(([lon, lat]) => project(lon, lat, midLat))
  const bx = {
    minX: Math.min(...projRing.map((p) => p.x)),
    maxX: Math.max(...projRing.map((p) => p.x)),
    minY: Math.min(...projRing.map((p) => p.y)),
    maxY: Math.max(...projRing.map((p) => p.y))
  }

  const w = bx.maxX - bx.minX
  const h = bx.maxY - bx.minY
  const scale = 1 / Math.max(w, h)

  // normalize polygon to 0..1 space
  const normPoly = projRing.map((p) => ({
    x: (p.x - bx.minX) * scale,
    y: (p.y - bx.minY) * scale
  }))

  // sample points in 0..1 box using rejection (Poisson-ish)
  const pts: { x: number; y: number }[] = []
  const triesMax = dotCount * 120

  function farEnough(x: number, y: number) {
    const md2 = minDist * minDist
    for (const p of pts) {
      if (dist2(x, y, p.x, p.y) < md2) return false
    }
    return true
  }

  let tries = 0
  while (pts.length < dotCount && tries < triesMax) {
    tries++
    const x = Math.random()
    const y = Math.random()
    if (!pointInPoly(x, y, normPoly)) continue
    if (!farEnough(x, y)) continue
    pts.push({ x, y })
  }

  // If outline is very thin / sampling failed, loosen constraints
  if (pts.length < Math.floor(dotCount * 0.65)) {
    const pts2: { x: number; y: number }[] = []
    const triesMax2 = dotCount * 200
    let t2 = 0
    const loMin = minDist * 0.72
    const loD2 = loMin * loMin
    const far2 = (x: number, y: number) => {
      for (const p of pts2) if (dist2(x, y, p.x, p.y) < loD2) return false
      return true
    }
    while (pts2.length < dotCount && t2 < triesMax2) {
      t2++
      const x = Math.random()
      const y = Math.random()
      if (!pointInPoly(x, y, normPoly)) continue
      if (!far2(x, y)) continue
      pts2.push({ x, y })
    }
    if (pts2.length > pts.length) pts.splice(0, pts.length, ...pts2)
  }

  // Map to SVG px space
  const targetSize = 980 // base size
  const pxPts = pts.map((p) => ({ x: p.x * targetSize, y: p.y * targetSize }))

  const minX2 = Math.min(...pxPts.map((p) => p.x))
  const minY2 = Math.min(...pxPts.map((p) => p.y))
  const maxX2 = Math.max(...pxPts.map((p) => p.x))
  const maxY2 = Math.max(...pxPts.map((p) => p.y))

  const width = maxX2 - minX2 + padPx * 2
  const height = maxY2 - minY2 + padPx * 2

  // shift to padding
  for (const p of pxPts) {
    p.x = p.x - minX2 + padPx
    p.y = p.y - minY2 + padPx
  }

  // Build neighbor graph:
  // - find radius from nearest neighbor statistics
  // - connect within radius and clamp to maxK nearest
  const n = pxPts.length
  const neigh = Array.from({ length: n }, () => new Set<number>())

  // estimate local radius
  const nearestDists: number[] = []
  for (let i = 0; i < n; i++) {
    let best = Infinity
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const d = Math.sqrt(dist2(pxPts[i].x, pxPts[i].y, pxPts[j].x, pxPts[j].y))
      if (d < best) best = d
    }
    if (isFinite(best)) nearestDists.push(best)
  }
  nearestDists.sort((a, b) => a - b)
  const median = nearestDists[Math.floor(nearestDists.length * 0.55)] || 60
  const radius = median * 2.05

  for (let i = 0; i < n; i++) {
    // collect candidates within radius
    const cands: { j: number; d: number }[] = []
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const d = Math.sqrt(dist2(pxPts[i].x, pxPts[i].y, pxPts[j].x, pxPts[j].y))
      if (d <= radius) cands.push({ j, d })
    }
    cands.sort((a, b) => a.d - b.d)
    const picked = cands.slice(0, maxK)
    for (const { j } of picked) {
      neigh[i].add(j)
      neigh[j].add(i)
    }
  }

  // Build Dots
  const dots: Dot[] = pxPts.map((p, i) => ({
    id: i,
    x: p.x,
    y: p.y,
    neighbors: Array.from(neigh[i]).sort((a, b) => a - b)
  }))

  // prune isolated
  const keep = dots.filter((d) => d.neighbors.length > 0)
  if (keep.length < dots.length) {
    const map = new Map<number, number>()
    keep.forEach((d, i) => map.set(d.id, i))
    const rebuilt: Dot[] = keep.map((d) => ({
      id: map.get(d.id)!,
      x: d.x,
      y: d.y,
      neighbors: d.neighbors.map((n) => map.get(n)!).filter((v) => v != null).sort((a, b) => a - b)
    }))
    return { dots: rebuilt, width, height }
  }

  return { dots, width, height }
}

/* =========================================================
   FALLBACK "CITY-LIKE" MASK (ONLY if GeoJSON fetch fails)
========================================================= */
function makeTriField(opts?: { rows?: number; cols?: number; spacing?: number; margin?: number }) {
  const rows = opts?.rows ?? 12
  const cols = opts?.cols ?? 14
  const s = opts?.spacing ?? 52
  const m = opts?.margin ?? 80

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

  const pad = 78
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

// fallback city-like: “river cut”
function fallbackRiverCity() {
  const field = makeTriField({ rows: 13, cols: 17, spacing: 52, margin: 86 })
  const dots = field.dots
  const minX = Math.min(...dots.map((d) => d.x))
  const maxX = Math.max(...dots.map((d) => d.x))
  const minY = Math.min(...dots.map((d) => d.y))
  const maxY = Math.max(...dots.map((d) => d.y))
  const cx = (minX + maxX) / 2
  const riverY = (minY + maxY) / 2
  const riverW = (maxY - minY) * 0.10

  return remapFilteredBoard(field, (d) => {
    const bend = Math.sin((d.x - cx) / 160) * 28
    const yLine = riverY + bend
    const inRiver = Math.abs(d.y - yLine) < riverW
    return !inRiver
  })
}

/* =========================================================
   BOARD PRESETS (REAL CITY MAPS)
   Best practice: copy GeoJSON to /public/maps and use local URLs.
========================================================= */
type BoardPreset = {
  id: string
  name: string
  tag: 'City Map'
  description: string
  theme: { fogA: string; fogB: string; accentA: string; accentB: string }
  geojsonUrl: string // boundary outline
  dotCount: number
  fallback: () => { dots: Dot[]; width: number; height: number }
}

const BOARD_PRESETS: BoardPreset[] = [
  {
    id: 'dhaka',
    name: 'Dhaka — City Boundary',
    tag: 'City Map',
    description: 'Real outline-based dot map (GeoJSON).',
    theme: {
      fogA: 'rgba(0,240,255,0.18)',
      fogB: 'rgba(255,61,166,0.12)',
      accentA: '#00F0FF',
      accentB: '#FF3DA6'
    },
    // if you also saved Dhaka locally, use: '/maps/dhaka.geojson'
    geojsonUrl:
        'https://gist.githubusercontent.com/EmranAhmed/e1f1da00b6677aed023a/raw/cc9d96ab36289786f491c9cfd537fe01b8121318/dhaka.geojson',
    dotCount: 95,
    fallback: fallbackRiverCity
  },

  {
    id: 'tokyo',
    name: 'Tokyo — City Boundary',
    tag: 'City Map',
    description: 'Real Tokyo boundary (GeoJSON).',
    // if you saved Tokyo locally, use: '/maps/tokyo.geo.json'
    theme: {
      fogA: 'rgba(120,90,255,0.16)',
      fogB: 'rgba(0,240,255,0.12)',
      accentA: '#7E5CFF',
      accentB: '#00F0FF'
    },
    geojsonUrl: 'https://raw.githubusercontent.com/utisz/compound-cities/master/tokyo.geo.json',
    dotCount: 110,
    fallback: fallbackRiverCity
  },

  {
    id: 'kolkata',
    name: 'Kolkata — City Boundary',
    tag: 'City Map',
    description: 'Local GeoJSON (public/maps/kolkata.geojson).',
    theme: {
      fogA: 'rgba(255,61,166,0.14)',
      fogB: 'rgba(120,90,255,0.12)',
      accentA: '#FF3DA6',
      accentB: '#7E5CFF'
    },
    geojsonUrl: '/maps/kolkata.geojson', // ✅ local
    dotCount: 95,
    fallback: fallbackRiverCity
  },

  {
    id: 'barcelona',
    name: 'Barcelona — City Boundary',
    tag: 'City Map',
    description: 'Local GeoJSON (public/maps/barcelona.geojson).',
    theme: {
      fogA: 'rgba(120,255,70,0.12)',
      fogB: 'rgba(0,240,255,0.12)',
      accentA: '#78FF46',
      accentB: '#00F0FF'
    },
    geojsonUrl: '/maps/barcelona.geojson', // ✅ local
    dotCount: 105,
    fallback: fallbackRiverCity
  }
]

/* =========================================================
   BOARD STATE
========================================================= */
const selectedBoardId = ref<string>('tokyo')
const selectedPreset = computed(() => BOARD_PRESETS.find((p) => p.id === selectedBoardId.value) ?? BOARD_PRESETS[0])

const board = ref<{ dots: Dot[]; width: number; height: number }>(selectedPreset.value.fallback())
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
  }, 620)
}

const recentEdgeKeys = ref(new Set<EdgeKey>())
function markEdge(key: EdgeKey) {
  recentEdgeKeys.value.add(key)
  recentEdgeKeys.value = new Set(recentEdgeKeys.value)
  window.setTimeout(() => {
    recentEdgeKeys.value.delete(key)
    recentEdgeKeys.value = new Set(recentEdgeKeys.value)
  }, 680)
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
   SELECTION (RESTORED) + CLICK CONNECT (RESTORED)
========================================================= */
const selectedDotId = ref<number | null>(null)
const selectedDot = computed(() =>
    selectedDotId.value == null ? null : dotsById.value.get(selectedDotId.value) || null
)
const neighborIds = computed(() => new Set(selectedDot.value?.neighbors ?? []))

function onDotClick(id: number) {
  if (phase.value !== 'playing') return
  if (currentPlayer.value.isAI) return

  // BEFORE ROLL: selection only
  if (rolled.value == null || linesLeft.value <= 0) {
    selectedDotId.value = selectedDotId.value === id ? null : id
    return
  }

  // After roll: classic 2-click connect
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
  if (!ok) return

  const key = makeEdgeKey(a, b)
  markEdge(key)

  linesLeft.value = Math.max(0, linesLeft.value - 1)
  const got = claimTrianglesForEdge(key)
  if (got > 0) flash(`⚡ +${got}`)

  selectedDotId.value = b
  if (linesLeft.value === 0) void endTurn()
}

/* =========================================================
   DRAG CONNECT (FIXED)
   - Optional: press dot, drag to neighbor, release to connect
   - Uses SVG pointer capture + correct viewBox conversion
========================================================= */
const svgEl = ref<SVGSVGElement | null>(null)
const dragging = ref(false)
const dragFrom = ref<number | null>(null)
const dragHover = ref<number | null>(null)
const pointerSvg = ref({ x: 0, y: 0 })
const activePointerId = ref<number | null>(null)

function svgPointFromEvent(e: PointerEvent) {
  const svg = svgEl.value
  if (!svg) return { x: 0, y: 0 }
  const rect = svg.getBoundingClientRect()
  const vb = svg.viewBox.baseVal
  const sx = vb.width / rect.width
  const sy = vb.height / rect.height
  const x = (e.clientX - rect.left) * sx + vb.x
  const y = (e.clientY - rect.top) * sy + vb.y
  return { x, y }
}

function nearestDot(x: number, y: number, max = 28) {
  const maxD2 = max * max
  let best: { id: number; d2: number } | null = null
  for (const d of board.value.dots) {
    const d2 = dist2(x, y, d.x, d.y)
    if (d2 <= maxD2 && (!best || d2 < best.d2)) best = { id: d.id, d2 }
  }
  return best?.id ?? null
}

function beginDragFromDot(id: number, e: PointerEvent) {
  if (phase.value !== 'playing') return
  if (currentPlayer.value.isAI) return

  // keep the old selection behavior:
  // we set selected always when touching a dot (feels good)
  selectedDotId.value = id

  // drag only meaningful after roll
  if (rolled.value == null || linesLeft.value <= 0) return

  dragging.value = true
  dragFrom.value = id
  dragHover.value = null
  pointerSvg.value = svgPointFromEvent(e)
  activePointerId.value = e.pointerId

  // capture on SVG (reliable across browsers)
  svgEl.value?.setPointerCapture?.(e.pointerId)
}

function onSvgPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  if (activePointerId.value != null && e.pointerId !== activePointerId.value) return

  pointerSvg.value = svgPointFromEvent(e)

  const a = dragFrom.value
  if (a == null) return

  const near = nearestDot(pointerSvg.value.x, pointerSvg.value.y, 34)
  if (near == null) {
    dragHover.value = null
    return
  }

  // only hover if neighbor of a
  const da = dotsById.value.get(a)
  if (!da?.neighbors.includes(near)) {
    dragHover.value = null
    return
  }
  dragHover.value = near
}

function endDrag(e: PointerEvent) {
  if (!dragging.value) return
  if (activePointerId.value != null && e.pointerId !== activePointerId.value) return

  dragging.value = false
  activePointerId.value = null

  const a = dragFrom.value
  const b = dragHover.value
  dragFrom.value = null
  dragHover.value = null

  if (a == null || b == null) return
  if (phase.value !== 'playing') return
  if (currentPlayer.value.isAI) return
  if (rolled.value == null || linesLeft.value <= 0) return
  if (a === b) return

  const da = dotsById.value.get(a)
  if (!da?.neighbors.includes(b)) return
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
  if (!ok) return

  const key = makeEdgeKey(a, b)
  markEdge(key)
  linesLeft.value = Math.max(0, linesLeft.value - 1)

  const got = claimTrianglesForEdge(key)
  if (got > 0) flash(`⚡ +${got}`)

  selectedDotId.value = b
  if (linesLeft.value === 0) void endTurn()
}

function cancelDrag() {
  dragging.value = false
  dragFrom.value = null
  dragHover.value = null
  activePointerId.value = null
}

onMounted(() => {
  window.addEventListener('pointerup', (e) => endDrag(e as PointerEvent), { passive: true })
  window.addEventListener('pointercancel', cancelDrag)
  window.addEventListener('blur', cancelDrag)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerup', (e) => endDrag(e as PointerEvent))
  window.removeEventListener('pointercancel', cancelDrag)
  window.removeEventListener('blur', cancelDrag)
})

/* =========================================================
   AI (unchanged)
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
    const setupWeight = afterLines > 0 ? 720 : 55
    const dangerWeight = afterLines > 0 ? 130 : 690
    const oppBest = opponentBestImmediateAfter(m.key)
    const oppWeight = afterLines > 0 ? 190 : 720
    const center = edgeCenterBonus(m.a, m.b)

    const score =
        immediate * 5200 +
        setup * setupWeight -
        danger * dangerWeight -
        oppBest * oppWeight +
        center * 28 +
        Math.random() * 0.10

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
    if (got > 0) flash(`⚡ +${got}`)
    await sleep(150)
  }

  if (phase.value === 'playing' && currentPlayer.value.isAI && linesLeft.value === 0) {
    await endTurn()
  }
}

/* =========================================================
   LOAD BOARD (FETCH REAL GEOJSON)
========================================================= */
const boardLoading = ref(false)
const boardError = ref<string | null>(null)

async function loadBoard(id: string) {
  selectedBoardId.value = id
  boardError.value = null
  boardLoading.value = true

  // always reset state
  hardResetState()

  const preset = selectedPreset.value
  try {
    // client-only fetch (avoid SSR)
    if (!import.meta.client) {
      board.value = preset.fallback()
      buildTriangles()
      boardLoading.value = false
      return
    }

    const res = await fetch(preset.geojsonUrl, { cache: 'force-cache' })
    if (!res.ok) throw new Error(`GeoJSON fetch failed (${res.status})`)
    const geo = await res.json()

    const rings = extractOuterRingsFromGeoJSON(geo)
    if (!rings.length) throw new Error('No Polygon/MultiPolygon rings found')

    // pick the largest ring by bbox area (usually the main city boundary)
    let best = rings[0]
    let bestArea = -Infinity
    for (const r of rings) {
      const bb = bboxOf(r)
      const area = (bb.maxLon - bb.minLon) * (bb.maxLat - bb.minLat)
      if (area > bestArea) {
        bestArea = area
        best = r
      }
    }

    board.value = buildDotsFromOutline(best, {
      dotCount: preset.dotCount,
      minDist: 0.012,
      maxK: 7,
      pad: 90
    })

    buildTriangles()
  } catch (e: any) {
    boardError.value = e?.message ?? 'Failed to load city map'
    // fallback to city-like board so game remains playable
    board.value = preset.fallback()
    buildTriangles()
  } finally {
    boardLoading.value = false
  }
}

/* =========================================================
   RESET / START
========================================================= */
function hardResetState() {
  edges.value = []
  edgeSet.value = new Set()
  rolled.value = null
  linesLeft.value = 0
  selectedDotId.value = null
  message.value = ''
  currentPlayerIndex.value = 0
  cancelDrag()

  for (const t of triangles.value) t.owner = null
  for (const p of players.value) p.score = 0
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
  cancelDrag()
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

/* =========================================================
   ON FIRST LOAD: pre-load selected board in setup
========================================================= */
onMounted(() => {
  // load initial map for setup preview
  void loadBoard(selectedBoardId.value)
})
</script>

<template>
  <div
      class="wrap"
      :style="{
      '--fogA': selectedPreset.theme.fogA,
      '--fogB': selectedPreset.theme.fogB,
      '--accentA': selectedPreset.theme.accentA,
      '--accentB': selectedPreset.theme.accentB
    }"
  >
    <!-- animated energy background layers -->
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
      <div class="subtitle">
        Pick a <b>real city map</b> (GeoJSON boundary) → dots fill the actual outline.
      </div>

      <div class="setupGrid">
        <div class="boardPicker neonCard">
          <div class="pickerTitle">
            <div class="pickerLabel neonText">City Maps</div>
            <div class="pickerHint">
              Controls in match: Roll dice → click a dot to select → click a neighbor to connect.
              <span class="muted">(Drag also works)</span>
            </div>
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
            <button class="btn primary neonBtn big" @click="startGame" :disabled="boardLoading">
              <span class="zap">⚡</span> Start Match
            </button>

            <div class="note" v-if="boardLoading">Loading map…</div>
            <div class="note" v-else-if="boardError">
              ⚠️ Map load failed: <b>{{ boardError }}</b>
              <div class="muted">Using fallback board. To fix: download GeoJSON to /public/maps and use local URL.</div>
            </div>
            <div class="note" v-else>
              Map loaded: <b>{{ board.dots.length }}</b> dots • <b>{{ triangles.length }}</b> triangles
            </div>
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
              <g opacity="0.13">
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
                <circle
                    v-for="d in board.dots"
                    :key="`pvd-${d.id}`"
                    :cx="d.x"
                    :cy="d.y"
                    :r="7.5"
                    class="pvDot"
                />
              </g>
            </svg>
          </div>

          <div class="previewFooter">
            <div class="tinyTip">
              Best reliability: put files in <code>/public/maps/</code> and use local URLs.
            </div>
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
            <span class="hudPill">
              Lines: <b class="pulseNum">{{ linesLeft }}</b>
            </span>
            <span class="hudPill" v-if="rolled != null">
              Rolled: <b class="pulseNum">{{ rolled }}</b>
            </span>
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

          <div v-if="message" class="pill warn neonWarn zapMsg">
            <span class="miniZap">⚡</span> {{ message }}
          </div>
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
        <svg
            ref="svgEl"
            class="svg"
            :viewBox="`0 0 ${board.width} ${board.height}`"
            preserveAspectRatio="xMidYMid meet"
            @pointermove="onSvgPointerMove"
            style="touch-action: none"
        >
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
              <stop offset="0%" stop-color="var(--accentA)" stop-opacity="0.15" />
              <stop offset="35%" stop-color="var(--accentA)" stop-opacity="0.95" />
              <stop offset="65%" stop-color="var(--accentB)" stop-opacity="0.95" />
              <stop offset="100%" stop-color="var(--accentB)" stop-opacity="0.15" />
              <animate attributeName="x1" values="0%;100%;0%" dur="1.6s" repeatCount="indefinite" />
              <animate attributeName="x2" values="100%;0%;100%" dur="1.6s" repeatCount="indefinite" />
            </linearGradient>
          </defs>

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

          <!-- Drag preview line -->
          <g v-if="dragging && dragFrom != null" filter="url(#glow)">
            <line
                :x1="dotsById.get(dragFrom)!.x"
                :y1="dotsById.get(dragFrom)!.y"
                :x2="dragHover != null ? dotsById.get(dragHover)!.x : pointerSvg.x"
                :y2="dragHover != null ? dotsById.get(dragHover)!.y : pointerSvg.y"
                class="previewLine"
                :class="{ ok: dragHover != null }"
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

          <!-- Neighbor hints (selection restored) -->
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
                class="hintLine hintElectric"
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
                :fill="d.id === selectedDotId ? '#ffffff' : neighborIds.has(d.id) ? 'var(--accentA)' : '#C9D3E8'"
                stroke="rgba(0,0,0,0.78)"
                stroke-width="2"
                :class="[
                'dotCircle',
                d.id === selectedDotId ? 'dotSelected' : '',
                neighborIds.has(d.id) ? 'dotNeighbor' : '',
                dragHover === d.id ? 'dotHover' : ''
              ]"
                @pointerdown.stop.prevent="beginDragFromDot(d.id, $event)"
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
            <button class="btn primary neonBtn" @click="resetMatch"><span class="zap">⚡</span> Play Again</button>
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
  --fogA: rgba(0,240,255,0.18);
  --fogB: rgba(255,61,166,0.12);
  --accentA: #00F0FF;
  --accentB: #FF3DA6;

  min-height: 100vh;
  color: #fff;
  padding: 16px;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  position: relative;
  overflow: hidden;
  background: #02030a;
}

/* background */
.bgEnergy{ position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden; }
.bgAurora{ position: absolute; inset: -20%; filter: blur(26px); opacity: 0.8; mix-blend-mode: screen; transform: translateZ(0); }
.bgAurora.a1{
  background:
      radial-gradient(900px 620px at 20% 18%, var(--fogA), transparent 62%),
      radial-gradient(980px 650px at 82% 62%, var(--fogB), transparent 64%),
      radial-gradient(700px 520px at 55% 10%, rgba(120,90,255,0.18), transparent 60%);
  animation: auroraDrift1 8.5s ease-in-out infinite alternate;
}
.bgAurora.a2{
  background:
      radial-gradient(900px 620px at 80% 22%, rgba(120,255,70,0.12), transparent 62%),
      radial-gradient(900px 620px at 45% 78%, rgba(0,240,255,0.12), transparent 62%),
      radial-gradient(700px 520px at 16% 70%, rgba(255,61,166,0.10), transparent 60%);
  animation: auroraDrift2 10.5s ease-in-out infinite alternate;
  opacity: 0.60;
}
.bgAurora.a3{
  background: conic-gradient(from 180deg at 50% 50%,
  rgba(0,240,255,0.12),
  rgba(255,61,166,0.10),
  rgba(120,90,255,0.10),
  rgba(120,255,70,0.08),
  rgba(0,240,255,0.12)
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
  position: relative;
  overflow: hidden;
}
.neonText{
  text-shadow: 0 0 18px rgba(0,240,255,0.34), 0 0 28px rgba(255,61,166,0.16);
}

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

/* setup */
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
  transition: transform 140ms ease, box-shadow 180ms ease, background 180ms ease, filter 180ms ease;
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

/* dice (kept from your previous style) */
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
}
.svg{ width: 100%; height: 75vh; display:block; }

/* edges */
.edgeLine{ stroke-width: 5; stroke-linecap: round; opacity: 0.95; filter: drop-shadow(0 0 14px rgba(0,240,255,0.18)); }
.edgeCurrent{ stroke-width: 3.4; stroke-linecap: round; opacity: 0.60; stroke-dasharray: 10 12; animation: currentFlow 1.0s linear infinite; mix-blend-mode: screen; }
@keyframes currentFlow{ from{ stroke-dashoffset: 0; opacity: 0.52; } to{ stroke-dashoffset: -44; opacity: 0.72; } }
.edgeLine.electric{ stroke-dasharray: 12 10; animation: edgeShiver 1.45s ease-in-out infinite; }
@keyframes edgeShiver{ 0%,100%{ stroke-dashoffset: 0; filter: brightness(1); } 50%{ stroke-dashoffset: -22; filter: brightness(1.12); } }
.edgeZap{ animation: edgeZap 680ms ease-out both; }
@keyframes edgeZap{ 0%{ stroke-width: 1; opacity: 0.25; filter: brightness(1.5); } 45%{ stroke-width: 6.6; opacity: 1; filter: brightness(1.25); } 100%{ stroke-width: 5; opacity: 0.95; filter: brightness(1); } }

/* drag preview */
.previewLine{
  stroke: rgba(255,255,255,0.25);
  stroke-width: 4;
  stroke-linecap: round;
  stroke-dasharray: 10 10;
  opacity: 0.85;
  animation: previewFlow 0.9s linear infinite;
}
.previewLine.ok{ stroke: rgba(0,240,255,0.55); filter: drop-shadow(0 0 12px rgba(0,240,255,0.18)); }
@keyframes previewFlow{ from{ stroke-dashoffset: 0; } to{ stroke-dashoffset: -32; } }

/* triangles */
.triFill{ transform-box: fill-box; transform-origin: center; transition: opacity 180ms ease; }
.triPop{ animation: triPop 620ms cubic-bezier(.18,.9,.18,1.02); filter: drop-shadow(0 0 20px rgba(0,240,255,0.20)); }
@keyframes triPop{ 0%{ transform: scale(0.84); opacity: 0.06; } 36%{ transform: scale(1.14); opacity: 0.30; } 100%{ transform: scale(1.00); opacity: 0.22; } }

/* hints */
.hintLine{ filter: drop-shadow(0 0 14px rgba(0,240,255,0.20)); }
.hintElectric{ stroke-dasharray: 8 10; animation: hintFlow 0.9s linear infinite; }
@keyframes hintFlow{ from{ stroke-dashoffset: 0; opacity: 0.35; } to{ stroke-dashoffset: -34; opacity: 0.62; } }

/* dots (keep subtle; selection is the main animation) */
.dotCircle{ cursor:pointer; transition: opacity 160ms ease, filter 160ms ease, transform 140ms ease; }
.dotSelected{
  transform: scale(1.06);
  filter: brightness(1.25) drop-shadow(0 0 24px rgba(0,240,255,0.26));
}
.dotNeighbor{
  filter: brightness(1.18) drop-shadow(0 0 18px rgba(0,240,255,0.22));
}
.dotHover{
  transform: scale(1.08);
  filter: brightness(1.22) drop-shadow(0 0 26px rgba(0,240,255,0.32));
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

/* modal */
.modal{ position: fixed; inset: 0; background: rgba(0,0,0,0.62); display: grid; place-items: center; padding: 16px; z-index: 50; }
.modalCard{ width: min(520px, 100%); padding: 16px; border-radius: 18px; }
.pop{ animation: popIn 240ms ease-out both; }
@keyframes popIn{ from{ transform: scale(0.96); opacity: 0; } to{ transform: scale(1); opacity: 1; } }
.modalTitle{ font-size: 20px; font-weight: 1000; }
.modalSub{ margin-top: 6px; opacity: 0.88; }
.modalBtns{ display:flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
</style>