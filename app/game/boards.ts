// game/boards.ts
import type { Dot, Edge, Triangle } from './types'

export type BoardDef = {
  dots: Dot[]
  edges: Edge[]
  triangles: Triangle[]
}

/**
 * SMALL board = 2x2 cells, each cell split diagonally (top-left to bottom-right)
 * - Dots: (0..2) x (0..2) => 9 dots
 * - Edges: horizontal + vertical + diagonals per cell
 * - Triangles: 2 per cell => 8 triangles
 */
export function createSmallBoard(): BoardDef {
  const dots: Dot[] = []
  const edges: Edge[] = []
  const triangles: Triangle[] = []

  // Helpers
  const dotId = (x: number, y: number) => `D_${x}_${y}`
  const edgeId = (a: string, b: string) => {
    // stable undirected id
    const [p, q] = a < b ? [a, b] : [b, a]
    return `E_${p}__${q}`
  }

  // 1) Create dots (3x3)
  // Coordinates mapped to 0..100 for SVG
  const toCoord = (i: number) => (i / 2) * 80 + 10 // 10..90

  for (let y = 0; y <= 2; y++) {
    for (let x = 0; x <= 2; x++) {
      dots.push({
        id: dotId(x, y),
        x: toCoord(x),
        y: toCoord(y)
      })
    }
  }

  // 2) Edge add (dedupe)
  const edgeMap = new Map<string, Edge>()
  function addEdge(a: string, b: string) {
    const id = edgeId(a, b)
    if (!edgeMap.has(id)) {
      edgeMap.set(id, { id, a, b, owner: null })
    }
    return id
  }

  // 3) Add horizontal + vertical edges
  for (let y = 0; y <= 2; y++) {
    for (let x = 0; x < 2; x++) {
      addEdge(dotId(x, y), dotId(x + 1, y))
    }
  }
  for (let x = 0; x <= 2; x++) {
    for (let y = 0; y < 2; y++) {
      addEdge(dotId(x, y), dotId(x, y + 1))
    }
  }

  // 4) Add diagonals and triangles per cell
  let triCount = 0
  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      const tl = dotId(cx, cy)
      const tr = dotId(cx + 1, cy)
      const bl = dotId(cx, cy + 1)
      const br = dotId(cx + 1, cy + 1)

      // diagonal: tl -> br
      const diag = addEdge(tl, br)

      // Triangle A: tl-tr-br
      const e1 = addEdge(tl, tr)
      const e2 = addEdge(tr, br)
      const e3 = diag
      triangles.push({
        id: `T_${++triCount}`,
        edgeIds: [e1, e2, e3],
        owner: null
      })

      // Triangle B: tl-bl-br
      const f1 = addEdge(tl, bl)
      const f2 = addEdge(bl, br)
      const f3 = diag
      triangles.push({
        id: `T_${++triCount}`,
        edgeIds: [f1, f2, f3],
        owner: null
      })
    }
  }

  // Finalize edges array
  edges.push(...edgeMap.values())

  return { dots, edges, triangles }
}