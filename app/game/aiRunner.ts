// app/game/aiRunner.ts
import type { GameState } from './types'
import { rollDice, getLegalMoves, applyMove } from './engine'
import { chooseMoveAI } from './ai'

export function runAiTurnOnce(state: GameState): GameState {
  // safety
  if (state.status !== 'playing') return state
  if (state.currentPlayer !== 'AI') return state

  // 1) roll dice (MVP: dice doesn't restrict moves yet)
  let next = rollDice(state)

  // 2) pick move
  const moves = getLegalMoves(next)
  const chosen = chooseMoveAI(next, moves)
  if (!chosen) return next

  // 3) apply move
  next = applyMove(next, chosen)
  return next
}