// app/game/utils.ts
import type { Edge, Triangle, PlayerId } from './types'

export function getEdgeById(edges: Edge[], id: string) {
  const e = edges.find((x) => x.id === id)
  if (!e) throw new Error(`Edge not found: ${id}`)
  return e
}

export function allEdgesOwned(tri: Triangle, edges: Edge[]) {
  return tri.edgeIds.every((eid) => {
    const e = edges.find((x) => x.id === eid)
    return !!e && e.owner !== null
  })
}

export function triangleOwnerIfComplete(tri: Triangle, edges: Edge[]): PlayerId | null {
  // Triangle is complete if all 3 edges owned AND all owned by same player
  const owners = tri.edgeIds.map((eid) => edges.find((e) => e.id === eid)?.owner ?? null)
  if (owners.some((o) => o === null)) return null
  if (owners[0] === owners[1] && owners[1] === owners[2]) return owners[0] as PlayerId
  return null
}