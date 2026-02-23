// app/game/types.ts

export type PlayerId = 'HUMAN' | 'AI'
export type GameStatus = 'idle' | 'playing' | 'ended'

export type Dot = {
  id: string
  x: number // for rendering later (SVG)
  y: number
}

export type Edge = {
  id: string
  a: string // dot id
  b: string // dot id
  owner: PlayerId | null
}

export type Triangle = {
  id: string
  edgeIds: [string, string, string]
  owner: PlayerId | null
}

export type Dice = {
  value: number | null
  sides: number
}

export type Scores = Record<PlayerId, number>

export type Move = {
  type: 'CLAIM_EDGE'
  edgeId: string
}

export type GameConfig = {
  board: 'SMALL' | 'MEDIUM'
  diceSides: number // e.g. 6
  startingPlayer: PlayerId
}

export type GameState = {
  config: GameConfig
  status: GameStatus

  currentPlayer: PlayerId
  turn: number

  dice: Dice
  dots: Dot[]
  edges: Edge[]
  triangles: Triangle[]

  scores: Scores

  // used later for UX
  lastMove: Move | null
  lastTriangleCaptures: string[] // triangle ids captured by last move
  winner: PlayerId | 'DRAW' | null
}