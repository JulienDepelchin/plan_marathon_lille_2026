/**
 * Outils géométriques pour le survol : rééchantillonnage régulier du tracé
 * (turf.js), lissage de la trajectoire caméra, profil de vitesse variable.
 * Toutes les distances sont en mètres, les temps en secondes.
 */
import * as turf from "@turf/turf";
import type { Feature, LineString, Position } from "geojson";

export interface Sample {
  lng: number;
  lat: number;
  d: number; // distance cumulée depuis le départ (m)
}

/** Points réguliers tous les `stepM` mètres le long du tracé (turf.along). */
export function resample(line: Feature<LineString>, stepM = 5): Sample[] {
  const totalKm = turf.length(line, { units: "kilometers" });
  const n = Math.floor((totalKm * 1000) / stepM);
  const out: Sample[] = [];
  for (let i = 0; i <= n; i++) {
    const d = i * stepM;
    const p = turf.along(line, d / 1000, { units: "kilometers" }).geometry.coordinates;
    out.push({ lng: p[0], lat: p[1], d });
  }
  const coords = line.geometry.coordinates;
  const last = coords[coords.length - 1];
  if (totalKm * 1000 - out[out.length - 1].d > 0.5) {
    out.push({ lng: last[0], lat: last[1], d: totalKm * 1000 });
  }
  return out;
}

/**
 * Lissage par moyenne glissante (appliquée `passes` fois ≈ noyau triangulaire).
 * `windowM` = demi-largeur de la fenêtre. Les distances `d` sont conservées :
 * on lisse la forme de la trajectoire, pas la progression.
 */
export function smooth(samples: Sample[], windowM: number, passes = 2): Sample[] {
  if (samples.length < 3 || windowM <= 0) return samples;
  const step = samples[1].d - samples[0].d;
  const half = Math.max(1, Math.round(windowM / step));
  let cur = samples;
  for (let p = 0; p < passes; p++) {
    const prefLng = [0];
    const prefLat = [0];
    for (const s of cur) {
      prefLng.push(prefLng[prefLng.length - 1] + s.lng);
      prefLat.push(prefLat[prefLat.length - 1] + s.lat);
    }
    const next: Sample[] = new Array(cur.length);
    for (let i = 0; i < cur.length; i++) {
      const a = Math.max(0, i - half);
      const b = Math.min(cur.length - 1, i + half);
      const cnt = b - a + 1;
      next[i] = {
        lng: (prefLng[b + 1] - prefLng[a]) / cnt,
        lat: (prefLat[b + 1] - prefLat[a]) / cnt,
        d: cur[i].d,
      };
    }
    cur = next;
  }
  return cur;
}

/** Position interpolée à la distance `d` (extrapolée en ligne droite hors bornes). */
export function sampleAt(samples: Sample[], d: number): [number, number] {
  const total = samples[samples.length - 1].d;
  if (d <= 0) return extrapolate(samples[0], samples[1], -d);
  if (d >= total) return extrapolate(samples[samples.length - 1], samples[samples.length - 2], d - total);
  const step = samples[1].d - samples[0].d;
  let i = Math.min(Math.floor(d / step), samples.length - 2);
  while (i < samples.length - 2 && samples[i + 1].d < d) i++;
  while (i > 0 && samples[i].d > d) i--;
  const a = samples[i];
  const b = samples[i + 1];
  const t = (d - a.d) / (b.d - a.d);
  return [a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t];
}

/** Prolonge la trajectoire au-delà de `from`, à l'opposé de `toward`, de `dist` m. */
function extrapolate(from: Sample, toward: Sample, dist: number): [number, number] {
  if (dist <= 0) return [from.lng, from.lat];
  const bearing = turf.bearing([from.lng, from.lat], [toward.lng, toward.lat]);
  const p = turf.destination([from.lng, from.lat], dist / 1000, bearing + 180, { units: "kilometers" });
  return p.geometry.coordinates as [number, number];
}

/** Cap (−180..180) de la course à la distance d. */
export function bearingAt(samples: Sample[], d: number, lookM = 30): number {
  const a = sampleAt(samples, d - lookM / 2);
  const b = sampleAt(samples, d + lookM / 2);
  return turf.bearing(a, b);
}

/**
 * Distance le long du tracé du point de passage le plus proche d'un lieu.
 * Le tracé repassant par les mêmes rues, il peut y avoir plusieurs passages :
 * on regroupe les candidats (< `maxDistM`) en passages distincts et on choisit
 * celui le plus proche de `kmHint` s'il est fourni, sinon le premier.
 */
export function locateOnRoute(
  samples: Sample[],
  coord: [number, number],
  kmHint?: number,
  maxDistM = 250
): { d: number; distToRoute: number } | null {
  const target = turf.point(coord);
  type Cand = { d: number; dist: number; lastD: number };
  const passes: Cand[] = [];
  let current: Cand | null = null;
  for (const s of samples) {
    const dist = turf.distance(target, [s.lng, s.lat], { units: "kilometers" }) * 1000;
    if (dist >= maxDistM) continue;
    if (current && s.d - current.lastD > 600) {
      passes.push(current);
      current = null;
    }
    if (!current) current = { d: s.d, dist, lastD: s.d };
    else {
      current.lastD = s.d;
      if (dist < current.dist) {
        current.dist = dist;
        current.d = s.d;
      }
    }
  }
  if (current) passes.push(current);
  if (!passes.length) return null;
  const pick =
    kmHint == null
      ? passes[0]
      : passes.reduce((best, p) =>
          Math.abs(p.d / 1000 - kmHint) < Math.abs(best.d / 1000 - kmHint) ? p : best
        );
  return { d: pick.d, distToRoute: pick.dist };
}

/**
 * Profil de vitesse : vitesse de base, ralentissement progressif (smoothstep)
 * à l'approche des lieux (`slowZones` = distances le long du tracé, en m).
 */
export interface Timeline {
  times: number[]; // temps cumulé (s) à chaque sample
  total: number; // durée totale (s)
}

export function buildTimeline(
  samples: Sample[],
  slowZones: number[],
  opts: { baseSpeed: number; slowSpeed: number; slowRadius: number }
): Timeline {
  const times = [0];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].d;
    let near = Infinity;
    for (const z of slowZones) near = Math.min(near, Math.abs(d - z));
    const k = Math.min(1, near / opts.slowRadius); // 0 = sur le lieu, 1 = hors zone
    const ease = k * k * (3 - 2 * k);
    const v = opts.slowSpeed + (opts.baseSpeed - opts.slowSpeed) * ease;
    times.push(times[i - 1] + (d - samples[i - 1].d) / v);
  }
  return { times, total: times[times.length - 1] };
}

/** Inverse de la timeline : distance parcourue au temps t. */
export function distanceAtTime(samples: Sample[], tl: Timeline, t: number): number {
  if (t <= 0) return 0;
  if (t >= tl.total) return samples[samples.length - 1].d;
  let lo = 0;
  let hi = tl.times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tl.times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - tl.times[lo]) / (tl.times[hi] - tl.times[lo]);
  return samples[lo].d + (samples[hi].d - samples[lo].d) * f;
}

/** Temps auquel on atteint la distance d (pour "sauter" à un lieu). */
export function timeAtDistance(samples: Sample[], tl: Timeline, d: number): number {
  if (d <= 0) return 0;
  const total = samples[samples.length - 1].d;
  if (d >= total) return tl.total;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].d <= d) lo = mid;
    else hi = mid;
  }
  const f = (d - samples[lo].d) / (samples[hi].d - samples[lo].d);
  return tl.times[lo] + (tl.times[hi] - tl.times[lo]) * f;
}

export function toLineString(coords: Position[]): Feature<LineString> {
  return turf.lineString(coords);
}
