<script setup lang="ts">
import type { Dot, Edge, Move, PlayerId } from '~/game/types'

const props = defineProps<{
  dots: Dot[]
  edges: Edge[]
  legalMoves: Move[]
  currentPlayer: PlayerId
}>()

const emit = defineEmits<{
  (e: 'claim', move: Move): void
}>()

const legalSet = computed(() => new Set(props.legalMoves.map((m) => m.edgeId)))

function isLegalEdge(edgeId: string) {
  return legalSet.value.has(edgeId)
}

function onEdgeClick(edgeId: string) {
  if (!isLegalEdge(edgeId)) return
  emit('claim', { type: 'CLAIM_EDGE', edgeId })
}

// ViewBox padding for nicer layout
const vbMin = 0
const vbMax = 100

function edgeColor(owner: PlayerId | null) {
  if (owner === 'HUMAN') return '#22c55e' // green
  if (owner === 'AI') return '#ef4444' // red
  return '#94a3b8' // gray
}

function edgeWidth(owner: PlayerId | null, legal: boolean) {
  if (owner) return 6
  if (legal) return 6
  return 4
}

function edgeOpacity(owner: PlayerId | null, legal: boolean) {
  if (owner) return 1
  if (legal) return 1
  return 0.35
}
</script>

<template>
  <div style="width: 100%; max-width: 520px;">
    <svg
      :viewBox="`${vbMin} ${vbMin} ${vbMax} ${vbMax}`"
      style="width: 100%; height: auto; border-radius: 14px; background: #0b1220; border: 1px solid #1f2a44;"
    >
      <!-- Edges (clickable) -->
      <g>
        <template v-for="e in edges" :key="e.id">
          <!-- wide invisible hit area for easy tapping -->
          <line
            :x1="dots.find(d => d.id === e.a)?.x"
            :y1="dots.find(d => d.id === e.a)?.y"
            :x2="dots.find(d => d.id === e.b)?.x"
            :y2="dots.find(d => d.id === e.b)?.y"
            stroke="transparent"
            stroke-width="18"
            stroke-linecap="round"
            style="cursor: pointer;"
            @click="onEdgeClick(e.id)"
          />
          <!-- visible edge -->
          <line
            :x1="dots.find(d => d.id === e.a)?.x"
            :y1="dots.find(d => d.id === e.a)?.y"
            :x2="dots.find(d => d.id === e.b)?.x"
            :y2="dots.find(d => d.id === e.b)?.y"
            :stroke="edgeColor(e.owner)"
            :stroke-width="edgeWidth(e.owner, isLegalEdge(e.id))"
            :opacity="edgeOpacity(e.owner, isLegalEdge(e.id))"
            stroke-linecap="round"
            :style="{
              cursor: isLegalEdge(e.id) ? 'pointer' : 'default',
              filter: isLegalEdge(e.id) && !e.owner ? 'drop-shadow(0 0 6px rgba(56,189,248,0.55))' : 'none'
            }"
            @click="onEdgeClick(e.id)"
          />
        </template>
      </g>

      <!-- Dots -->
      <g>
        <circle
          v-for="d in dots"
          :key="d.id"
          :cx="d.x"
          :cy="d.y"
          r="4.5"
          fill="#e2e8f0"
        />
      </g>
    </svg>

    <div style="margin-top: 10px; font-size: 13px; color: #9fb0d0;">
      Tip: glowing edges are legal moves (tap/click them).
    </div>
  </div>
</template>