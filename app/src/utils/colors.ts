/**
 * Gradient utilities. We keep three flavors:
 *  - hours cell: 0 → blank, 1 → light green, 2 → fuller, 3 → strong, 4+ → deep
 *  - boolean cell: 0 → blank, 1 → strong green
 *  - results / percentage: 0 → soft yellow, 100 → deep green, 100+ → darker green
 *
 * Colors are emitted as hsl() so they interpolate smoothly between stops.
 */

interface Stop {
  /** input value */
  v: number;
  /** [hue, saturation%, lightness%] */
  hsl: [number, number, number];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function toCss([h, s, l]: [number, number, number]): string {
  return `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`;
}

function interpolate(stops: Stop[], v: number): string {
  if (v <= stops[0].v) return toCss(stops[0].hsl);
  if (v >= stops[stops.length - 1].v) return toCss(stops[stops.length - 1].hsl);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (v >= a.v && v <= b.v) {
      const t = (v - a.v) / (b.v - a.v);
      return toCss([
        lerp(a.hsl[0], b.hsl[0], t),
        lerp(a.hsl[1], b.hsl[1], t),
        lerp(a.hsl[2], b.hsl[2], t),
      ]);
    }
  }
  return toCss(stops[stops.length - 1].hsl);
}

const HOURS_STOPS: Stop[] = [
  { v: 0, hsl: [50, 0, 100] }, // empty: white
  { v: 0.5, hsl: [55, 90, 92] }, // hint of yellow
  { v: 1, hsl: [70, 80, 78] }, // pale yellow-green
  { v: 2, hsl: [95, 70, 62] }, // green-yellow
  { v: 3, hsl: [115, 60, 48] }, // green
  { v: 4, hsl: [125, 65, 38] }, // strong green
  { v: 6, hsl: [135, 70, 28] }, // deeper
  { v: 10, hsl: [140, 80, 18] }, // very deep
];

const RESULT_STOPS: Stop[] = [
  { v: 0, hsl: [50, 90, 92] }, // pale yellow
  { v: 25, hsl: [60, 85, 75] },
  { v: 50, hsl: [85, 70, 60] },
  { v: 75, hsl: [105, 65, 48] },
  { v: 100, hsl: [125, 70, 38] }, // satisfying green
  { v: 130, hsl: [135, 80, 28] },
  { v: 160, hsl: [140, 90, 20] },
  { v: 200, hsl: [145, 100, 14] }, // very dark deep green
];

export function colorForHours(v: number): string {
  if (!v || v <= 0) return "transparent";
  return interpolate(HOURS_STOPS, v);
}

export function colorForBoolean(v: number): string {
  if (!v || v <= 0) return "transparent";
  // Map 0..1 to a comfortable strong green
  const stops: Stop[] = [
    { v: 0, hsl: [50, 0, 100] },
    { v: 1, hsl: [125, 70, 45] },
  ];
  return interpolate(stops, Math.min(1, v));
}

export function colorForResult(v: number): string {
  return interpolate(RESULT_STOPS, v);
}

/**
 * Colour a "missed" cell. `zeros` is how many of the selected categories were
 * zero on that day; `total` is how many were selected. We map ratio→red:
 *   0%   missing → transparent
 *   1/n  missing → very light pink
 *   ...
 *   100% missing → saturated light red
 */
export function colorForMiss(zeros: number, total: number): string {
  if (total <= 0 || zeros <= 0) return "transparent";
  const ratio = Math.min(1, zeros / total);
  const stops: Stop[] = [
    { v: 0, hsl: [0, 0, 100] },
    { v: 0.25, hsl: [4, 80, 92] },
    { v: 0.5, hsl: [4, 80, 84] },
    { v: 0.75, hsl: [4, 80, 76] },
    { v: 1, hsl: [4, 78, 68] },
  ];
  return interpolate(stops, ratio);
}

export function textColorFor(bg: string): string {
  // Heuristic: the lightness of the background determines text color.
  const m = /hsl\(([-\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)/.exec(bg);
  if (!m) return "#1c1917";
  const l = parseFloat(m[3]);
  return l < 50 ? "#fafaf9" : "#1c1917";
}
