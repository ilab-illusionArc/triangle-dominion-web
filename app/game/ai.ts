// app/game/ai.ts
import type { GameState, Move } from './types'

export function chooseMoveAI(state: GameState, moves: Move[]): Move | null {
  if (!moves.length) return null

  // Priority 1: pick a move that captures at least one triangle immediately
  const capturing = moves.filter((m) => wouldCaptureTriangle(state, m))
  if (capturing.length) return capturing[0] // simple: first capturing move

  // Otherwise: random move
  return moves[Math.floor(Math.random() * moves.length)]
}

function wouldCaptureTriangle(state: GameState, move: Move): boolean {
  if (move.type !== 'CLAIM_EDGE') return false

  // If claiming this edge would complete any triangle (all 3 edges owned by same player),
  // then it captures. Since move owner is currentPlayer, we simulate that edge as owned.

  const owner = state.currentPlayer
  const newEdges = state.edges.map((e) =>
    e.id === move.edgeId ? { ...e, owner } : e
  )

  return state.triangles.some((t) => {
    if (t.owner !== null) return false
    const owners = t.edgeIds.map((eid) => newEdges.find((e) => e.id === eid)?.owner ?? null)
    if (owners.some((o) => o === null)) return false
    return owners[0] === owners[1] && owners[1] === owners[2]
  })
}