/**
 * Caméra de survol (« chase cam »), fonction pure et déterministe : même entrée → même image,
 * ce qui permet de la simuler hors navigateur (scripts) et de la rendre image par image.
 *
 * Modèle :
 *  - la CIBLE est un point de la trajectoire lissée, `lookAhead` m devant le coureur, au sol ;
 *  - le CAP est le cap local de la course (mesuré sur ±100 m de trajectoire lissée), filtré dans le
 *    temps et plafonné en vitesse de rotation — c'est lui qui absorbe virages et épingles ;
 *  - la POSITION est placée derrière la cible, à l'opposé du cap, à la distance qui donne exactement
 *    le `pitch` demandé pour l'altitude courante. Le pitch est donc constant par construction,
 *    contrairement à une caméra qui suivrait « le point situé N m en arrière sur le tracé » (quand le
 *    parcours se replie sur lui-même, ce point peut se retrouver à côté de la cible et le pitch s'effondre) ;
 *  - l'ALTITUDE monte dans les zones tortueuses (sinuosité relissée sur ±1 km) avec une constante de
 *    temps longue : elle ne pompe pas.
 */
import * as turf from "@turf/turf";
import { bearingAt, profileAt, sampleAt, type Sample } from "./path";

export interface CamParams {
  altitude: number; // m
  pitch: number; // ° (0 = du dessus, 80 = rasant)
  lookAhead: number; // m devant le coureur
}

export interface CamState {
  rate: number; // multiplicateur de vitesse de lecture
  camTgt: [number, number] | null;
  camBearing: number | null; // ° (−180..180)
  camAlt: number | null; // m
}

export interface CamGeo {
  samples: Sample[];
  smoothed: Sample[];
  curvatureLift: number[];
  curveLift: number;
}

export interface CamPose {
  position: [number, number];
  altitude: number;
  target: [number, number];
  bearing: number;
}

/** Distance horizontale caméra → cible pour un pitch et une altitude donnés. */
export function horizontalDistance(altitude: number, pitchDeg: number): number {
  return altitude * Math.tan((Math.min(85, Math.max(5, pitchDeg)) * Math.PI) / 180);
}

/** Recul derrière le coureur (info pour le panneau de réglage). */
export function lookBehindOf(p: CamParams): number {
  return Math.max(20, horizontalDistance(p.altitude, p.pitch) - p.lookAhead);
}

const MAX_TURN_RATE = 40; // °/s de rotation de cap, maximum
const TAU_ALT = 4; // s, filtre d'altitude
const TAU_BEARING = 1.0; // s, filtre de cap
const TAU_TARGET = 0.3; // s, filtre de cible

export function newCamState(rate: number): CamState {
  return { rate, camTgt: null, camBearing: null, camAlt: null };
}

export function resetCamState(a: CamState) {
  a.camTgt = null;
  a.camBearing = null;
  a.camAlt = null;
}

/**
 * Pose caméra à la distance `d` (m) le long du tracé, `dt` secondes après la pose précédente.
 * Met à jour l'état filtré `a`.
 */
export function computeCamera(geo: CamGeo, d: number, a: CamState, p: CamParams, dt: number): CamPose {
  const first = a.camTgt == null;

  // altitude
  const wantAlt = p.altitude * (1 + geo.curveLift * profileAt(geo.samples, geo.curvatureLift, d));
  a.camAlt = first || a.camAlt == null ? wantAlt : a.camAlt + (wantAlt - a.camAlt) * (1 - Math.exp(-dt / TAU_ALT));

  // cible
  const tgt = sampleAt(geo.smoothed, d + p.lookAhead);
  a.camTgt = first || a.camTgt == null ? tgt : lerp(a.camTgt, tgt, 1 - Math.exp(-dt / TAU_TARGET));

  // cap : filtre exponentiel sur l'angle (avec enroulement) + plafond de vitesse de rotation
  const wantBearing = bearingAt(geo.smoothed, d, 200);
  if (first || a.camBearing == null) a.camBearing = wantBearing;
  else {
    const diff = wrap180(wantBearing - a.camBearing);
    let step = diff * (1 - Math.exp(-dt / TAU_BEARING));
    const maxStep = MAX_TURN_RATE * dt;
    if (step > maxStep) step = maxStep;
    if (step < -maxStep) step = -maxStep;
    a.camBearing = wrap180(a.camBearing + step);
  }

  // position : derrière la cible, à l'opposé du cap, à la distance qui donne le pitch demandé
  const horiz = horizontalDistance(a.camAlt, p.pitch);
  const pos = turf.destination(a.camTgt, horiz / 1000, a.camBearing + 180, { units: "kilometers" }).geometry
    .coordinates as [number, number];

  return { position: pos, altitude: a.camAlt, target: a.camTgt, bearing: a.camBearing };
}

function wrap180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

function lerp(a: [number, number], b: [number, number], k: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
