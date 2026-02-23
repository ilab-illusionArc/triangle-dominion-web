// app/game/engine.ts
import type { GameConfig, GameState, Move, PlayerId, Scores } from './types'
import { createSmallBoard } from './boards'
import { getEdgeById, triangleOwnerIfComplete } from './utils'

function initialScores(): Scores {
  return { HUMAN: 0, AI: 0 }
}

export function newGame(config?: Partial<GameConfig>): GameState {
  const merged: GameConfig = {
    board: config?.board ?? 'SMALL',
    diceSides: config?.diceSides ?? 6,
    startingPlayer: config?.startingPlayer ?? 'HUMAN'
  }

  const board = createSmallBoard()

  return {
    config: merged,
    status: 'playing',
    currentPlayer: merged.startingPlayer,
    turn: 1,
    dice: { value: null, sides: merged.diceSides },
    dots: board.dots,
    edges: board.edges,
    triangles: board.triangles,
    scores: initialScores(),
    lastMove: null,
    lastTriangleCaptures: [],
    winner: null
  }
}

export function rollDice(state: GameState): GameState {
  if (state.status !== 'playing') return state
  const value = Math.floor(Math.random() * state.dice.sides) + 1
  return {
    ...state,
    dice: { ...state.dice, value }
  }
}

export function getLegalMoves(state: GameState): Move[] {
  if (state.status !== 'playing') return []
  // For MVP: legal move = claim any unowned edge
  return state.edges
    .filter((e) => e.owner === null)
    .map((e) => ({ type: 'CLAIM_EDGE', edgeId: e.id }))
}

export function applyMove(state: GameState, move: Move): GameState {
  if (state.status !== 'playing') return state
  if (move.type !== 'CLAIM_EDGE') return state

  // Must be legal
  const legal = getLegalMoves(state).some((m) => m.edgeId === move.edgeId)
  if (!legal) return state

  // Claim edge
  const edges = state.edges.map((e) =>
    e.id === move.edgeId ? { ...e, owner: state.currentPlayer } : e
  )

  // Check triangle captures (only triangles not yet owned)
  const captured: string[] = []
  const triangles = state.triangles.map((t) => {
    if (t.owner !== null) return t
    const owner = triangleOwnerIfComplete(t, edges)
    if (owner) {
      captured.push(t.id)
      return { ...t, owner }
    }
    return t
  })

  // Update scores (+1 per triangle for now)
  const scores = { ...state.scores }
  if (captured.length) {
    scores[state.currentPlayer] += captured.length
  }

  // End game if all edges owned
  const allClaimed = edges.every((e) => e.owner !== null)
  let status: GameState['status'] = state.status
  let winner: GameState['winner'] = state.winner
  if (allClaimed) {
    status = 'ended'
    const h = scores.HUMAN
    const a = scores.AI
    winner = h === a ? 'DRAW' : h > a ? 'HUMAN' : 'AI'
  }

  // Turn switch (simple):
  // If you captured a triangle, you keep the turn (classic triangle games often do this).
  // If your GDD says otherwise, we’ll change it later.
  const nextPlayer: PlayerId =
    captured.length > 0 ? state.currentPlayer : state.currentPlayer === 'HUMAN' ? 'AI' : 'HUMAN'

  const nextTurn = captured.length > 0 ? state.turn : state.turn + 1

  return {
    ...state,
    edges,
    triangles,
    scores,
    status,
    winner,
    currentPlayer: status === 'ended' ? state.currentPlayer : nextPlayer,
    turn: status === 'ended' ? state.turn : nextTurn,
    lastMove: move,
    lastTriangleCaptures: captured
  }
}