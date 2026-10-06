import { DEFAULT_OPTION_COLORS, OptionColors, OptionListKey } from './types'

/**
 * The app's colour palette for colours that live in *data* rather than in CSS: the per-value tag
 * colours (statuses, customers) and release / workstream colours. Whatever a user picks is snapped
 * onto the nearest step, so every tag reads as part of one system in both themes. (The CSS tokens
 * in styles.css cover the rest.)
 */

/** Every step of the six palettes (blue, yellow, green, orange, red, neutral) + black and white. */
const PALETTE_STEPS = [
  '#e6f0fb', '#b0d1f3', '#8abbed', '#549ce5', '#3389e0', '#006bd8', '#005fc0', '#004c99', '#003b77', '#002d5b',
  '#fff8e7', '#ffe9b6', '#ffdf92', '#fed061', '#fec742', '#feb913', '#e7a811', '#b4830d', '#8c660a', '#6b4e08',
  '#e6f2ef', '#b0d8ce', '#8ac5b6', '#54aa94', '#339980', '#008060', '#007457', '#005b44', '#004635', '#003628',
  '#fff0e8', '#fed1b9', '#febb97', '#fe9c67', '#fd8949', '#fd6b1c', '#e66119', '#b44c14', '#8b3b0f', '#6a2d0c',
  '#fde9e6', '#f7bab0', '#f4998a', '#ee6b54', '#eb4e33', '#e62200', '#d11f00', '#a31800', '#7f1300', '#610e00',
  '#f7f8f9', '#e3e8ed', '#cbd1db', '#a6b0be', '#8390a2', '#64748b', '#5b6a7e', '#475263', '#2a313a', '#1d232c',
  '#ffffff', '#000000',
]

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Steps per palette in PALETTE_STEPS. */
const PALETTE_LEN = 10
/** Darkest step still readable as text on a dark surface: the 500 step is swapped for the 400,
 *  so tag colours keep their contrast. */
const DARKEST_ON_DARK = 4

/**
 * Closest palette step to an arbitrary colour, by RGB distance. Tag colours are user-editable
 * (Settings dialog), so custom values have to be mapped rather than looked up — e.g. #dc2626 →
 * red-500, #7e22ce → blue-700 (the palette has no purple). On dark surfaces the match is lightened
 * within its own palette so the tag text keeps its contrast.
 */
function nearestStep(hex: string, dark = false): string {
  const [r, g, b] = rgb(hex)
  let bestIdx = 0
  let bestD = Infinity
  PALETTE_STEPS.forEach((step, i) => {
    const [sr, sg, sb] = rgb(step)
    const d = (r - sr) ** 2 + (g - sg) ** 2 + (b - sb) ** 2
    if (d < bestD) {
      bestD = d
      bestIdx = i
    }
  })
  if (!dark) return PALETTE_STEPS[bestIdx]
  const palette = Math.floor(bestIdx / PALETTE_LEN)
  const step = bestIdx % PALETTE_LEN
  // grays sit outside the 10-step palettes and need no lightening
  if (palette * PALETTE_LEN + PALETTE_LEN > PALETTE_STEPS.length) return PALETTE_STEPS[bestIdx]
  return PALETTE_STEPS[palette * PALETTE_LEN + Math.min(step, DARKEST_ON_DARK)]
}

const OPTION_LISTS: OptionListKey[] = ['featureStatuses', 'roadmapStatuses', 'customers']

/**
 * The stored tag colours (defaults + whatever the db overrides) snapped onto the palette. Only
 * ever handed to the views for painting — never written back.
 */
export function paletteOptionColors(stored: OptionColors | undefined, dark = false): OptionColors {
  const out: OptionColors = {}
  for (const list of OPTION_LISTS) {
    const merged = { ...DEFAULT_OPTION_COLORS[list], ...stored?.[list] }
    const mapped: Record<string, string> = {}
    for (const [value, color] of Object.entries(merged)) mapped[value] = nearestStep(color, dark)
    out[list] = mapped
  }
  return out
}

/** Snap any stored colour (a release, a workstream) onto the palette for painting. */
export const paletteColor = (hex: string | undefined, dark = false): string | undefined => (hex ? nearestStep(hex, dark) : undefined)

/** Preset swatches offered for milestone / phase / release colours — the 500 steps. */
export const PRESET_COLORS = [
  { name: 'Yellow', hex: '#feb913' },
  { name: 'Red', hex: '#e62200' },
  { name: 'Green', hex: '#008060' },
  { name: 'Blue', hex: '#006bd8' },
] as const
