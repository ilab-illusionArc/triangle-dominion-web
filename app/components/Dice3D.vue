<script setup lang="ts">
import * as THREE from 'three'

const props = defineProps<{
  value: number
  canRoll: boolean
  animating: boolean
}>()

const emit = defineEmits<{ (e: 'roll'): void }>()

const host = ref<HTMLDivElement | null>(null)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let dice: THREE.Mesh | null = null
let raf = 0

// Rotation targets so the cube "shows" a face.
// These are approximate but consistent.
// (1 = top, 6 = bottom, etc. We'll map to “front-facing” looks.)
const faceRot: Record<number, THREE.Euler> = {
  1: new THREE.Euler(-Math.PI / 2, 0, 0),
  2: new THREE.Euler(0, 0, 0),
  3: new THREE.Euler(0, -Math.PI / 2, 0),
  4: new THREE.Euler(0, Math.PI / 2, 0),
  5: new THREE.Euler(0, Math.PI, 0),
  6: new THREE.Euler(Math.PI / 2, 0, 0)
}

function makePipTexture() {
  // Create a crisp “dice face” texture (white face + dark pips + subtle vignette)
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  // base
  const g = ctx.createLinearGradient(0, 0, 0, size)
  g.addColorStop(0, '#f8fbff')
  g.addColorStop(1, '#cfd8e6')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  // vignette
  const v = ctx.createRadialGradient(size * 0.5, size * 0.45, size * 0.1, size * 0.5, size * 0.5, size * 0.55)
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(1, 'rgba(0,0,0,0.18)')
  ctx.fillStyle = v
  ctx.fillRect(0, 0, size, size)

  // rounded border hint
  ctx.strokeStyle = 'rgba(0,0,0,0.12)'
  ctx.lineWidth = 10
  ctx.strokeRect(12, 12, size - 24, size - 24)

  // pip helper
  const pip = (x: number, y: number) => {
    ctx.beginPath()
    ctx.arc(x, y, 28, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(10,14,25,0.92)'
    ctx.shadowColor = 'rgba(0,0,0,0.35)'
    ctx.shadowBlur = 10
    ctx.fill()
    ctx.shadowBlur = 0
  }

  // draw pips for each face in separate canvases
  const faces: HTMLCanvasElement[] = []
  const layouts: Record<number, Array<[number, number]>> = {
    1: [[0.5, 0.5]],
    2: [[0.3, 0.3], [0.7, 0.7]],
    3: [[0.3, 0.3], [0.5, 0.5], [0.7, 0.7]],
    4: [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]],
    5: [[0.3, 0.3], [0.7, 0.3], [0.5, 0.5], [0.3, 0.7], [0.7, 0.7]],
    6: [[0.3, 0.3], [0.7, 0.3], [0.3, 0.5], [0.7, 0.5], [0.3, 0.7], [0.7, 0.7]]
  }

  for (let n = 1; n <= 6; n++) {
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const cctx = c.getContext('2d')!
    cctx.drawImage(canvas, 0, 0)
    for (const [fx, fy] of layouts[n]) pip(fx * size, fy * size)
    faces.push(c)
  }
  return faces.map((c) => new THREE.CanvasTexture(c))
}

function setup() {
  if (!host.value) return

  scene = new THREE.Scene()
  scene.fog = new THREE.Fog('#04050a', 3.8, 10)

  const w = host.value.clientWidth
  const h = host.value.clientHeight

  camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 100)
  camera.position.set(0, 1.6, 4.1)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(w, h)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  host.value.appendChild(renderer.domElement)

  // Lights: neon rim + soft fill
  const key = new THREE.DirectionalLight('#b6f1ff', 1.25)
  key.position.set(3, 5, 4)
  scene.add(key)

  const rim = new THREE.DirectionalLight('#ff4fd8', 0.85)
  rim.position.set(-4, 2, -2)
  scene.add(rim)

  const amb = new THREE.AmbientLight('#88a0ff', 0.55)
  scene.add(amb)

  // Dice materials (6 faces)
  const faceTex = makePipTexture()
  faceTex.forEach((t) => {
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
  })

  const mats = faceTex.map(
    (map) =>
      new THREE.MeshStandardMaterial({
        map,
        roughness: 0.28,
        metalness: 0.15
      })
  )

  // BoxGeometry face order: +x, -x, +y, -y, +z, -z
  // We'll map textures so it feels correct visually (good enough for game feel).
  const geom = new THREE.BoxGeometry(1.2, 1.2, 1.2, 1, 1, 1)
  dice = new THREE.Mesh(geom, [mats[3], mats[2], mats[0], mats[5], mats[1], mats[4]])
  dice.castShadow = false
  dice.receiveShadow = false
  scene.add(dice)

  // initial pose
  const e = faceRot[props.value] ?? faceRot[1]
  dice.rotation.set(e.x, e.y, e.z)

  const tick = () => {
    raf = requestAnimationFrame(tick)
    if (!renderer || !scene || !camera || !dice) return

    // idle float (only when not animating)
    if (!props.animating) {
      const t = performance.now() * 0.001
      dice.position.y = Math.sin(t * 1.3) * 0.04
      dice.rotation.z += 0.002
    }

    renderer.render(scene, camera)
  }
  tick()

  const onResize = () => {
    if (!host.value || !renderer || !camera) return
    const ww = host.value.clientWidth
    const hh = host.value.clientHeight
    camera.aspect = ww / hh
    camera.updateProjectionMatrix()
    renderer.setSize(ww, hh)
  }
  window.addEventListener('resize', onResize)

  onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize)
  })
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}
function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3)
}

async function animateToFace(n: number) {
  if (!dice) return
  const target = faceRot[n] ?? faceRot[1]

  // big “real roll” spin first
  const start = dice.rotation.clone()
  const spin = new THREE.Euler(
    start.x + (Math.PI * 2) * (2 + Math.random() * 2),
    start.y + (Math.PI * 2) * (2 + Math.random() * 2),
    start.z + (Math.PI * 2) * (1 + Math.random() * 2)
  )

  const t0 = performance.now()
  const dur1 = 520
  await new Promise<void>((res) => {
    const step = () => {
      const t = clamp((performance.now() - t0) / dur1, 0, 1)
      const e = easeOutCubic(t)
      dice!.rotation.set(lerp(start.x, spin.x, e), lerp(start.y, spin.y, e), lerp(start.z, spin.z, e))
      dice!.position.y = 0.07 * Math.sin(e * Math.PI)
      if (t < 1) requestAnimationFrame(step)
      else res()
    }
    step()
  })

  // settle to exact face
  const t1 = performance.now()
  const dur2 = 260
  const s2 = dice.rotation.clone()
  await new Promise<void>((res) => {
    const step = () => {
      const t = clamp((performance.now() - t1) / dur2, 0, 1)
      const e = easeOutCubic(t)
      dice!.rotation.set(lerp(s2.x, target.x, e), lerp(s2.y, target.y, e), lerp(s2.z, target.z, e))
      dice!.position.y = 0.03 * Math.sin((1 - t) * Math.PI)
      if (t < 1) requestAnimationFrame(step)
      else res()
    }
    step()
  })
}

watch(
  () => props.value,
  (v) => {
    if (!import.meta.client) return
    // when the roll finishes and value updates, settle to that face
    if (!props.animating) void animateToFace(v)
  }
)

onMounted(() => {
  if (!import.meta.client) return
  setup()
})

function onClick() {
  if (!props.canRoll) return
  emit('roll')
}
</script>

<template>
  <button class="dice3d" :class="{ disabled: !canRoll, anim: animating }" @click="onClick" aria-label="Roll Dice">
    <div ref="host" class="host"></div>
    <div class="glass"></div>
    <div class="hint" v-if="canRoll">ROLL</div>
  </button>
</template>

<style scoped>
.dice3d{
  position: relative;
  width: 92px;
  height: 72px;
  border-radius: 18px;
  border: 1px solid rgba(255,255,255,0.16);
  background:
    radial-gradient(120px 90px at 30% 20%, rgba(80,220,255,0.22), transparent 55%),
    radial-gradient(120px 90px at 70% 80%, rgba(255,60,170,0.16), transparent 55%),
    rgba(0,0,0,0.35);
  box-shadow:
    0 0 0 1px rgba(80,220,255,0.12),
    0 0 32px rgba(80,220,255,0.18),
    0 0 44px rgba(255,60,170,0.10);
  cursor: pointer;
  transition: transform 140ms ease, box-shadow 180ms ease, filter 180ms ease;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}
.dice3d:hover{
  transform: translateY(-1px) scale(1.01);
  box-shadow:
    0 0 0 1px rgba(80,220,255,0.18),
    0 0 44px rgba(80,220,255,0.24),
    0 0 60px rgba(255,60,170,0.14);
}
.dice3d:active{ transform: translateY(0) scale(0.995); }
.dice3d.disabled{
  opacity: 0.55;
  cursor: not-allowed;
  filter: saturate(0.8);
}
.host{
  position:absolute;
  inset: 0;
  border-radius: 18px;
  overflow: hidden;
}
.glass{
  pointer-events:none;
  position:absolute;
  inset: 0;
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0.02));
  mix-blend-mode: screen;
  opacity: 0.65;
}
.hint{
  position:absolute;
  right: 10px;
  bottom: 8px;
  font-size: 10px;
  letter-spacing: 0.22em;
  font-weight: 950;
  opacity: 0.85;
  text-shadow: 0 0 18px rgba(80,220,255,0.35);
}
</style>