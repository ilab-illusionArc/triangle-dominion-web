// app/composables/useAudioFx.ts
type SfxName =
  | 'ui_click'
  | 'ui_hover'
  | 'ui_modal_open'
  | 'ui_modal_close'
  | 'ui_back'
  | 'ui_error'
  | 'dice_roll'
  | 'dice_land'
  | 'dot_select'
  | 'edge_draw'
  | 'edge_block'
  | 'triangle_claim'
  | 'triangle_multi'
  | 'turn_end'
  | 'ai_move'
  | 'game_over'
  | 'win_fanfare'
  | 'ambient_sparkle'

type BgmName = 'bgm_menu' | 'bgm_game'

const SFX_FILES: Record<SfxName, string> = {
  ui_click: '/audios/ui_click.wav',
  ui_hover: '/audios/ui_hover.wav',
  ui_modal_open: '/audios/ui_modal_open.wav',
  ui_modal_close: '/audios/ui_modal_close.wav',
  ui_back: '/audios/ui_back.wav',
  ui_error: '/audios/ui_error.wav',

  dice_roll: '/audios/dice_roll.wav',
  dice_land: '/audios/dice_land.wav',
  dot_select: '/audios/dot_select.wav',
  edge_draw: '/audios/edge_draw.wav',
  edge_block: '/audios/edge_block.wav',
  triangle_claim: '/audios/triangle_claim.wav',
  triangle_multi: '/audios/triangle_multi.wav',
  turn_end: '/audios/turn_end.wav',
  ai_move: '/audios/ai_move.wav',
  game_over: '/audios/game_over.wav',
  win_fanfare: '/audios/win_fanfare.wav',
  ambient_sparkle: '/audios/ambient_sparkle.wav'
}

const BGM_FILES: Record<BgmName, string> = {
  bgm_menu: '/audios/bgm_menu.mp3',
  bgm_game: '/audios/bgm_game.mp3'
}

/**
 * Simple, reliable HTMLAudio engine:
 * - SFX: small pool per sound for overlap
 * - BGM: single looping track with soft fade
 * - persisted mute + volume
 */
export function useAudioFx() {
  const enabled = useState<boolean>('audio_enabled', () => true)
  const sfxVol = useState<number>('audio_sfx_vol', () => 0.7)
  const bgmVol = useState<number>('audio_bgm_vol', () => 0.45)

  const _unlocked = useState<boolean>('audio_unlocked', () => false)

  const sfxPool = useState<Record<string, HTMLAudioElement[]>>('audio_sfx_pool', () => ({}))
  const bgm = useState<HTMLAudioElement | null>('audio_bgm', () => null)
  const bgmName = useState<BgmName | null>('audio_bgm_name', () => null)

  function loadPrefs() {
    if (!import.meta.client) return
    const e = localStorage.getItem('td_audio_enabled')
    const sv = localStorage.getItem('td_audio_sfx_vol')
    const bv = localStorage.getItem('td_audio_bgm_vol')
    if (e != null) enabled.value = e === '1'
    if (sv != null) sfxVol.value = clamp01(Number(sv))
    if (bv != null) bgmVol.value = clamp01(Number(bv))
  }

  function savePrefs() {
    if (!import.meta.client) return
    localStorage.setItem('td_audio_enabled', enabled.value ? '1' : '0')
    localStorage.setItem('td_audio_sfx_vol', String(sfxVol.value))
    localStorage.setItem('td_audio_bgm_vol', String(bgmVol.value))
  }

  function clamp01(n: number) {
    if (!Number.isFinite(n)) return 0.5
    return Math.max(0, Math.min(1, n))
  }

  /** Call on first user gesture (click/tap) to avoid autoplay blocks */
  async function unlockAudio() {
    if (!import.meta.client) return
    if (_unlocked.value) return
    _unlocked.value = true

    // "Warm up" by playing a silent tiny sound (some browsers like it)
    try {
      const a = new Audio()
      a.volume = 0
      a.src = SFX_FILES.ui_click
      await a.play()
      a.pause()
    } catch {
      // ignore: user gesture still unlocks for later plays
    }
  }

  function setEnabled(v: boolean) {
    enabled.value = v
    savePrefs()
    if (!enabled.value) stopBgm(true)
    else if (bgmName.value) void playBgm(bgmName.value)
  }

  function setVolumes(opts: { sfx?: number; bgm?: number }) {
    if (opts.sfx != null) sfxVol.value = clamp01(opts.sfx)
    if (opts.bgm != null) bgmVol.value = clamp01(opts.bgm)
    savePrefs()
    if (bgm.value) bgm.value.volume = enabled.value ? bgmVol.value : 0
  }

  function getFromPool(name: SfxName) {
    const key = name
    if (!sfxPool.value[key]) sfxPool.value[key] = []
    const pool = sfxPool.value[key]

    // reuse ended element; else create new
    for (const a of pool) {
      if (a.paused || a.ended) return a
    }
    const a = new Audio(SFX_FILES[name])
    a.preload = 'auto'
    pool.push(a)
    return a
  }

  function playSfx(name: SfxName, volumeMul = 1) {
    if (!import.meta.client) return
    if (!enabled.value) return
    // If not unlocked yet, still try; most events will be after a click anyway.
    const a = getFromPool(name)
    try {
      a.pause()
      a.currentTime = 0
      a.volume = clamp01(sfxVol.value * volumeMul)
      void a.play()
    } catch {
      // ignore
    }
  }

  async function playBgm(name: BgmName) {
    if (!import.meta.client) return
    bgmName.value = name
    if (!enabled.value) return

    // already playing same
    if (bgm.value && bgm.value.src.includes(BGM_FILES[name])) return

    // stop old
    stopBgm(true)

    const a = new Audio(BGM_FILES[name])
    a.loop = true
    a.preload = 'auto'
    a.volume = 0
    bgm.value = a

    try {
      await a.play()
      // fade in
      fadeTo(a, bgmVol.value, 420)
    } catch {
      // autoplay blocked until first user gesture — will work after unlockAudio()
    }
  }

  function stopBgm(immediate = false) {
    if (!import.meta.client) return
    const a = bgm.value
    if (!a) return
    if (immediate) {
      try {
        a.pause()
      } catch {}
      bgm.value = null
      return
    }
    fadeTo(a, 0, 280).then(() => {
      try {
        a.pause()
      } catch {}
      bgm.value = null
    })
  }

  function fadeTo(a: HTMLAudioElement, target: number, ms: number) {
    return new Promise<void>((resolve) => {
      const start = a.volume
      const t0 = performance.now()
      const step = () => {
        const t = (performance.now() - t0) / ms
        const k = Math.min(1, Math.max(0, t))
        a.volume = start + (target - start) * k
        if (k >= 1) resolve()
        else requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
  }

  /** helper: call in each page */
  function initAudio() {
    loadPrefs()
  }

  return {
    enabled,
    sfxVol,
    bgmVol,
    initAudio,
    unlockAudio,
    setEnabled,
    setVolumes,
    playSfx,
    playBgm,
    stopBgm
  }
}