/**
 * MarathonFlyover — carte 3D du parcours du marathon de Lille 2026.
 *
 * Composant autonome (aucun backend) : Mapbox GL JS *ou* MapLibre GL JS (prop `engine`) + turf.js.
 * Deux modes :
 *  - « explore » (défaut) : tracé complet, points cliquables (départ, ravitos, arrivée), vue libre,
 *    sélecteur de fond de carte pour le lecteur ;
 *  - « flyover » (optionnel) : caméra qui suit le tracé, révélation progressive, timeline,
 *    puis retour en exploration libre.
 *
 * La bibliothèque cartographique est chargée dynamiquement, côté client uniquement
 * (voir src/lib/engine.ts). Bascule Mapbox → MapLibre + OpenFreeMap/IGN : `engine="maplibre"`.
 *
 * Intégration Lovable : copier src/components, src/lib et src/data, ajouter les dépendances
 * mapbox-gl, maplibre-gl et @turf/turf, puis
 *   <MarathonFlyover mapboxToken="pk.…" height="100%" />
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type mapboxgl from "mapbox-gl";
import type { Feature, LineString, FeatureCollection, Point } from "geojson";

import parcoursRaw from "../data/parcours.json";
import kmRaw from "../data/km.json";
import { LIEUX, type Lieu } from "../data/lieux";
import { loadEngine, type Basemap, type Engine, type GL, type GLMap, type GLMarker } from "../lib/engine";
import {
  resample,
  smooth,
  sampleAt,
  locateOnRoute,
  buildTimeline,
  distanceAtTime,
  timeAtDistance,
  type Sample,
  type Timeline,
} from "../lib/path";

export type { Basemap, Engine };

// ───────────────────────── Réglages ─────────────────────────
const VDN_BLUE = "#0854e8";
const BG = "#0b1220";
const DEPART_COLOR = "#35b290";
const ARRIVEE_COLOR = "#e8412c";
const CASING = "rgba(255,255,255,0.9)";
const EXPLORE_PITCH = 50;

const BASEMAP_LABELS: Record<Basemap, string> = {
  standard: "3D",
  "standard-satellite": "Satellite",
  satellite: "Satellite (classique)",
  light: "Clair",
  dark: "Nuit",
};

export interface MarathonFlyoverProps {
  /** Moteur : "mapbox" (défaut, style Standard 3D) ou "maplibre" (OpenFreeMap + orthophoto IGN, sans clé) */
  engine?: Engine;
  /** Token public Mapbox (pk.…) — requis avec engine="mapbox", ignoré sinon */
  mapboxToken?: string;
  /** Fonds proposés au lecteur, dans l'ordre des boutons. Le premier est le fond initial. */
  basemaps?: Basemap[];
  /** Fond initial (sinon le premier de `basemaps`) */
  basemap?: Basemap;
  /** Préréglage lumière du style Mapbox Standard : "dawn" | "day" | "dusk" | "night" */
  lightPreset?: "dawn" | "day" | "dusk" | "night";
  /** Thème du style Mapbox Standard : "default" | "faded" | "monochrome" */
  theme?: "default" | "faded" | "monochrome";
  /** URL de style personnalisée (désactive le sélecteur de fond) */
  mapStyle?: string;
  /** Mode au chargement */
  startMode?: "explore" | "flyover";
  /** Propose le bouton « Survoler le parcours » en mode exploration */
  showFlyoverButton?: boolean;
  /** Vitesse de croisière du survol (m/s), à ×1 */
  baseSpeed?: number;
  /** Vitesse à l'approche des points (m/s) */
  slowSpeed?: number;
  /** Rayon (m) de la zone de ralentissement autour d'un point */
  slowRadius?: number;
  /** Altitude de la caméra de survol (m) */
  cameraAltitude?: number;
  /** Inclinaison de la caméra (°) : 0 = vue du dessus, 60 = oblique, 80 = rasante */
  cameraPitch?: number;
  /** Point visé devant le coureur (m) — le tracé apparaît jusque-là */
  lookAhead?: number;
  /** Demi-fenêtre de lissage de la trajectoire caméra (m) */
  smoothingWindow?: number;
  /** Bornes kilométriques sur le tracé (désactivées : notre mesure n'est pas celle de l'organisateur) */
  showKmMarkers?: boolean;
  /** Gestes coopératifs : zoom molette avec Ctrl/⌘, déplacement à deux doigts (indispensable en iframe) */
  cooperativeGestures?: boolean;
  /**
   * Bouton « Plein écran » (défaut : true). En iframe, l'attribut `allow="fullscreen"` est requis
   * sur l'iframe. Sur iPhone (pas d'API Fullscreen), le bouton ouvre la carte dans un nouvel onglet.
   */
  showFullscreenButton?: boolean;
  /** Hauteur CSS du composant */
  height?: string;
  /** Liste des points (par défaut src/data/lieux.ts) */
  lieux?: Lieu[];
  /** Panneau de calibrage de la caméra de survol — pour régler, pas pour publier */
  debug?: boolean;
  onFinish?: () => void;
}

const PARCOURS = parcoursRaw as Feature<LineString>;
const KM = kmRaw as FeatureCollection<Point>;

type Mode = "explore" | "playing" | "paused";

interface LieuPlace extends Lieu {
  d: number; // distance sur le tracé (m)
  distToRoute: number;
  coord: [number, number];
}

interface CamParams {
  altitude: number;
  pitch: number;
  lookAhead: number;
}

/** Recul de la caméra derrière le coureur, déduit du triangle altitude / pitch. */
function lookBehindOf(p: CamParams): number {
  const horiz = p.altitude * Math.tan((Math.min(85, Math.max(5, p.pitch)) * Math.PI) / 180);
  return Math.max(20, horiz - p.lookAhead);
}

/** Emprise du tracé [[ouest, sud], [est, nord]] */
const ROUTE_BOUNDS: [[number, number], [number, number]] = (() => {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const c of PARCOURS.geometry.coordinates) {
    const [lng = 0, lat = 0] = c;
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [[w, s], [e, n]];
})();

export default function MarathonFlyover({
  engine = "mapbox",
  mapboxToken,
  basemaps = ["standard", "standard-satellite"],
  basemap,
  lightPreset = "day",
  theme = "default",
  mapStyle,
  startMode = "explore",
  showFlyoverButton = true,
  baseSpeed = 120,
  slowSpeed = 40,
  slowRadius = 300,
  cameraAltitude = 500,
  cameraPitch = 70,
  lookAhead = 260,
  smoothingWindow = 120,
  showKmMarkers = false,
  cooperativeGestures = true,
  showFullscreenButton = true,
  height = "100vh",
  lieux = LIEUX,
  debug = false,
  onFinish,
}: MarathonFlyoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<GL | null>(null);
  const mapRef = useRef<GLMap | null>(null);
  const rafRef = useRef<number>(0);
  const markersRef = useRef<Map<string, GLMarker>>(new Map());
  const runnerRef = useRef<GLMarker | null>(null);

  // état d'animation hors React (60 fps)
  const anim = useRef({
    t: 0,
    last: 0,
    rate: 2, // ×2 par défaut
    camPos: null as [number, number] | null,
    camTgt: null as [number, number] | null,
  });

  const [mode, setMode] = useState<Mode>("explore");
  const modeRef = useRef<Mode>("explore");
  modeRef.current = mode;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [km, setKm] = useState(0);
  const [rate, setRate] = useState(2);
  const [lieuActif, setLieuActif] = useState<LieuPlace | null>(null);
  const [basemapState, setBasemapState] = useState<Basemap>(basemap ?? basemaps[0] ?? "standard");
  const basemapRef = useRef<Basemap>(basemapState);
  basemapRef.current = basemapState;
  const [cam, setCam] = useState<CamParams>({ altitude: cameraAltitude, pitch: cameraPitch, lookAhead });
  const camRef = useRef<CamParams>(cam);
  camRef.current = cam;

  useEffect(() => setCam({ altitude: cameraAltitude, pitch: cameraPitch, lookAhead }), [cameraAltitude, cameraPitch, lookAhead]);

  // ── Plein écran ──
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(fullscreenElement() === rootRef.current);
      // la taille du conteneur change : on force le recalcul du canvas
      requestAnimationFrame(() => mapRef.current?.resize());
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);
  const toggleFullscreen = () => {
    const el = rootRef.current;
    if (!el) return;
    if (!fullscreenSupported()) {
      // iPhone : pas d'API Fullscreen pour un <div> → la carte seule dans un nouvel onglet
      window.open(window.location.href, "_blank", "noopener");
      return;
    }
    if (fullscreenElement()) void exitFullscreen();
    else void requestFullscreen(el);
  };

  // ── Géométrie précalculée (une seule fois) ──
  const geo = useMemo(() => {
    const samples = resample(PARCOURS, 5);
    const smoothed = smooth(samples, smoothingWindow);
    const total = samples[samples.length - 1]?.d ?? 0;
    const places: LieuPlace[] = [];
    for (const l of lieux) {
      if (l.km != null) {
        const d = Math.min(Math.max(0, l.km * 1000), total);
        places.push({ ...l, d, distToRoute: 0, coord: sampleAt(samples, d) });
      } else if (l.coord) {
        const loc = locateOnRoute(samples, l.coord, l.kmHint);
        if (loc) places.push({ ...l, ...loc, coord: l.coord });
        else console.warn(`[MarathonFlyover] lieu « ${l.nom} » à plus de 250 m du tracé, ignoré`);
      }
    }
    places.sort((a, b) => a.d - b.d);
    const timeline: Timeline = buildTimeline(
      samples,
      places.map((p) => p.d),
      { baseSpeed, slowSpeed, slowRadius }
    );
    return { samples, smoothed, total, places, timeline };
  }, [lieux, baseSpeed, slowSpeed, slowRadius, smoothingWindow]);
  const geoRef = useRef(geo);
  geoRef.current = geo;

  const isFlat = (b: Basemap) => glRef.current?.isSatellite(b) ?? b.includes("satellite");

  // ── Carte : chargement du moteur puis création (une fois ; le fond change via setStyle) ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let map: GLMap | null = null;
    let firstLoad = true;

    (async () => {
      let gl: GL;
      try {
        gl = await loadEngine(engine);
      } catch (e) {
        console.error("[MarathonFlyover] moteur de carte indisponible", e);
        setError("La carte n'a pas pu être chargée.");
        return;
      }
      if (cancelled) return;
      if (engine === "mapbox" && !mapboxToken) {
        setError("Token Mapbox manquant (prop mapboxToken).");
        return;
      }
      glRef.current = gl;
      const [lng, lat] = sampleAt(geo.samples, 0);
      map = gl.createMap({
        container,
        style: mapStyle ?? gl.styleFor(basemapRef.current),
        center: [lng, lat],
        zoom: 16.5,
        pitch: 70,
        bearing: 0,
        cooperativeGestures,
        accessToken: mapboxToken,
      });
      mapRef.current = map;

      map.on("error", (e: { error?: { message?: string } }) => {
        // tuiles 403 (restrictions d'URL), style introuvable… : on le dit plutôt que d'afficher un fond noir
        const msg = e.error?.message ?? "";
        if (/403|Forbidden|Unauthorized|401/i.test(msg)) setError("Fond de carte refusé (token / restrictions d'URL).");
      });

      map.on("style.load", () => {
        if (!map) return;
        const b = basemapRef.current;
        setupStyle(gl, map, b, { custom: !!mapStyle, lightPreset, theme, showKmMarkers });

        const g = geoRef.current;
        if (modeRef.current === "explore") showEverything(map, g);
        else updateLayers(map, g, distanceAtTime(g.samples, g.timeline, anim.current.t));

        if (firstLoad) {
          firstLoad = false;
          if (startMode === "flyover") startFlyover(map);
          else enterExplore(map, true);
          setLoaded(true);
        }
      });
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      markersRef.current.forEach((m) => m.remove());
      markersRef.current.clear();
      runnerRef.current?.remove();
      runnerRef.current = null;
      map?.remove();
      mapRef.current = null;
      setLoaded(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, mapboxToken, mapStyle]);

  // ── Changement de fond : setStyle conserve caméra et marqueurs HTML ──
  const changeBasemap = (b: Basemap) => {
    if (b === basemapState || mapStyle) return;
    const wasFlat = isFlat(basemapState);
    basemapRef.current = b;
    setBasemapState(b);
    const map = mapRef.current;
    const gl = glRef.current;
    if (!map || !gl) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.setStyle(gl.styleFor(b) as any);
    // en exploration : satellite → vue à plat, retour en 3D → on rebascule l'inclinaison
    if (modeRef.current === "explore") {
      if (isFlat(b)) map.easeTo({ pitch: 0, duration: 900 });
      else if (wasFlat) map.easeTo({ pitch: EXPLORE_PITCH, duration: 900 });
    }
  };

  // ───────────── Mode exploration ─────────────
  const enterExplore = (map: GLMap, initial = false) => {
    const gl = glRef.current;
    if (!gl) return;
    cancelAnimationFrame(rafRef.current);
    setMode("explore");
    modeRef.current = "explore";
    setLieuActif(null);
    runnerRef.current?.remove();
    runnerRef.current = null;
    showEverything(map, geoRef.current);
    ensureAllMarkers(gl, map, geoRef.current, markersRef.current, (p) => {
      setLieuActif(p);
      map.flyTo({ center: p.coord, zoom: 16.5, pitch: isFlat(basemapRef.current) ? 0 : 62, bearing: map.getBearing(), duration: 1800 });
    });
    setInteractive(gl, map, true);
    map.fitBounds(ROUTE_BOUNDS, {
      padding: { top: 90, bottom: 80, left: 40, right: 40 },
      pitch: isFlat(basemapRef.current) ? 0 : EXPLORE_PITCH,
      bearing: -15,
      duration: initial ? 0 : 3000,
    });
  };

  /** Timeline : clic à une fraction du parcours → on y saute. */
  const seek = (fraction: number) => {
    const g = geoRef.current;
    const d = Math.max(0, Math.min(1, fraction)) * g.total;
    anim.current.t = timeAtDistance(g.samples, g.timeline, d);
    anim.current.camPos = null;
    anim.current.camTgt = null;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current.clear();
    if (mode !== "playing") play();
  };

  // ───────────── Mode survol ─────────────
  const startFlyover = (map: GLMap) => {
    const gl = glRef.current;
    if (!gl) return;
    anim.current.t = 0;
    anim.current.camPos = null;
    anim.current.camTgt = null;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current.clear();
    setLieuActif(null);
    setInteractive(gl, map, false);
    updateLayers(map, geoRef.current, 0);
    if (!runnerRef.current) {
      const el = document.createElement("div");
      el.className = "mf-runner";
      el.innerHTML = ICONS["runner"] ?? "";
      runnerRef.current = gl.marker(el, "center").setLngLat(sampleAt(geoRef.current.samples, 0)).addTo(map);
    }
    play();
  };

  const frame = (now: number) => {
    const map = mapRef.current;
    const gl = glRef.current;
    if (!map || !gl) return;
    const g = geoRef.current;
    const a = anim.current;
    const dt = a.last ? Math.min((now - a.last) / 1000, 0.1) : 0;
    a.last = now;
    a.t += dt * a.rate;

    const d = distanceAtTime(g.samples, g.timeline, a.t);
    applyCamera(gl, map, g, d, a, camRef.current, dt);
    updateLayers(map, g, d);
    runnerRef.current?.setLngLat(sampleAt(g.samples, d));
    revealPlaces(gl, map, g, d, markersRef.current, setLieuActif);
    setKm(d / 1000);

    if (a.t >= g.timeline.total) {
      finish();
      return;
    }
    rafRef.current = requestAnimationFrame(frame);
  };

  const play = () => {
    anim.current.last = 0;
    setMode("playing");
    modeRef.current = "playing";
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(frame);
  };
  const pause = () => {
    cancelAnimationFrame(rafRef.current);
    setMode("paused");
  };
  const changeRate = (r: number) => {
    anim.current.rate = r;
    setRate(r);
  };
  const finish = () => {
    const map = mapRef.current;
    if (map) enterExplore(map);
    onFinish?.();
  };

  const showBasemapSwitch = !mapStyle && basemaps.length > 1;
  const inFlyover = mode === "playing" || mode === "paused";
  const progress = Math.min(1, (km * 1000) / geo.total);
  const lookBehind = Math.round(lookBehindOf(cam));

  return (
    <div ref={rootRef} className={`mf-root ${inFlyover ? "mf-flyover" : ""}`} style={{ height }}>
      <style>{CSS}</style>
      <div ref={containerRef} className="mf-map" />

      {/* Bandeau titre */}
      <div className="mf-top">
        <div className="mf-title">
          <span className="mf-kicker">Marathon de Lille 2026</span>
          <span className="mf-hint">
            {inFlyover ? "Survol du parcours" : "Cliquez sur un point, glissez, zoomez, clic droit pour pivoter"}
          </span>
        </div>
      </div>

      {/* Timeline (survol uniquement) */}
      {inFlyover && (
        <div className="mf-timeline">
          <span className="mf-tl-label">Départ</span>
          <div
            className="mf-tl-track"
            role="slider"
            aria-label="Position sur le parcours"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              seek((e.clientX - r.left) / r.width);
            }}
          >
            <div className="mf-tl-fill" style={{ width: `${progress * 100}%` }} />
            {geo.places
              .filter((p) => p.type === "ravito")
              .map((p) => (
                <span key={p.id} className="mf-tl-tick" style={{ left: `${(p.d / geo.total) * 100}%` }} title={p.nom} />
              ))}
            <div className="mf-tl-knob" style={{ left: `${progress * 100}%` }} />
          </div>
          <span className="mf-tl-label">Arrivée</span>
        </div>
      )}

      {/* Sélecteur de fond */}
      {showBasemapSwitch && (
        <div className="mf-basemaps" role="group" aria-label="Fond de carte">
          {basemaps.map((b) => (
            <button key={b} className={`mf-seg ${basemapState === b ? "on" : ""}`} onClick={() => changeBasemap(b)}>
              {BASEMAP_LABELS[b]}
            </button>
          ))}
        </div>
      )}

      {/* Fiche point */}
      {lieuActif && (
        <div className="mf-card" key={lieuActif.id}>
          {mode === "explore" && (
            <button className="mf-card-close" onClick={() => setLieuActif(null)} aria-label="Fermer">×</button>
          )}
          <div className="mf-card-nom">{lieuActif.nom}</div>
          {lieuActif.description && <div className="mf-card-desc">{lieuActif.description}</div>}
          {lieuActif.horsTrace && <div className="mf-card-hors">à {lieuActif.horsTrace} m du tracé</div>}
        </div>
      )}

      {/* Panneau de calibrage (survol) */}
      {debug && inFlyover && (
        <div className="mf-debug">
          <Slider label="Altitude" unit="m" min={50} max={1200} step={10} value={cam.altitude} onChange={(v) => setCam({ ...cam, altitude: v })} />
          <Slider label="Pitch" unit="°" min={20} max={80} step={1} value={cam.pitch} onChange={(v) => setCam({ ...cam, pitch: v })} />
          <Slider label="Visée devant" unit="m" min={50} max={1000} step={10} value={cam.lookAhead} onChange={(v) => setCam({ ...cam, lookAhead: v })} />
          <div className="mf-debug-out">
            recul déduit ≈ {lookBehind} m — cameraAltitude={cam.altitude} cameraPitch={cam.pitch} lookAhead={cam.lookAhead} engine={engine}
          </div>
        </div>
      )}

      {/* Contrôles */}
      <div className="mf-controls">
        {error && <span className="mf-error">{error}</span>}
        {!loaded && !error && <span className="mf-loading">Chargement de la carte…</span>}
        {loaded && mode === "explore" && showFlyoverButton && (
          <button className="mf-btn" onClick={() => mapRef.current && startFlyover(mapRef.current)}>▶ Survoler le parcours</button>
        )}
        {mode === "playing" && <button className="mf-btn" onClick={pause}>❚❚ Pause</button>}
        {mode === "paused" && <button className="mf-btn primary" onClick={play}>▶ Reprendre</button>}
        {inFlyover && (
          <>
            <div className="mf-rates">
              {[1, 2, 4].map((r) => (
                <button key={r} className={`mf-btn small ${rate === r ? "on" : ""}`} onClick={() => changeRate(r)}>
                  ×{r}
                </button>
              ))}
            </div>
            <button className="mf-btn ghost" onClick={() => mapRef.current && enterExplore(mapRef.current)}>Explorer la carte</button>
          </>
        )}
        {loaded && showFullscreenButton && (
          <button
            className="mf-btn icon mf-fs"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Quitter le plein écran" : "Plein écran"}
            aria-label={isFullscreen ? "Quitter le plein écran" : "Plein écran"}
          >
            <span dangerouslySetInnerHTML={{ __html: isFullscreen ? ICONS["fsExit"] ?? "" : ICONS["fsEnter"] ?? "" }} />
            <span className="mf-fs-label">{isFullscreen ? "Quitter" : "Plein écran"}</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── Sous-composants ─────────────────────────

function Slider(props: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="mf-slider">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      <output>{props.value} {props.unit}</output>
    </label>
  );
}

// ───────────────────────── Helpers ─────────────────────────

/* API Fullscreen, avec le préfixe webkit des anciens Safari. */
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void; webkitFullscreenEnabled?: boolean };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
function fullscreenElement(): Element | null {
  const d = document as FsDoc;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}
function fullscreenSupported(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}
async function requestFullscreen(el: HTMLElement) {
  const e = el as FsEl;
  try {
    if (e.requestFullscreen) await e.requestFullscreen({ navigationUI: "hide" });
    else if (e.webkitRequestFullscreen) await e.webkitRequestFullscreen();
  } catch (err) {
    console.warn("[MarathonFlyover] plein écran refusé (iframe sans allow=\"fullscreen\" ?)", err);
  }
}
async function exitFullscreen() {
  const d = document as FsDoc;
  if (d.exitFullscreen) await d.exitFullscreen();
  else if (d.webkitExitFullscreen) await d.webkitExitFullscreen();
}

/** Pictos inline (SVG, rendu identique sur tous les OS — contrairement aux emojis). */
const SVG = (d: string) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS: Record<string, string> = {
  // bouteille d'eau
  ravito: SVG('<path d="M10 2h4M10 2v3.2L7.5 9.5V20a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2V9.5L14 5.2V2"/><path d="M7.5 13.5h9"/><path d="M7.5 17h9"/>'),
  // bouton « play »
  depart: SVG('<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="currentColor" stroke-width="1.5"/>'),
  // drapeau à damier
  arrivee: SVG('<path d="M5 22V3"/><path d="M5 4h13l-2.5 4 2.5 4H5"/><path d="M8 4v8M11.5 4v8M15 4v8M5 6.7h13M5 9.3h11.5" stroke-width="1.2"/>'),
  lieu: "",
  // plein écran : entrer / sortir
  fsEnter: SVG('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  fsExit: SVG('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  // coureur (pictogramme)
  runner: SVG(
    '<circle cx="16" cy="4" r="2" fill="currentColor" stroke="none"/>' +
      '<path d="M14.5 8.5 11.5 13"/>' +
      '<path d="M11.5 13 14 16.5 12 21"/>' +
      '<path d="M11.5 13 8.5 16 5 15"/>' +
      '<path d="M14.5 8.5 18 11 20.5 9"/>' +
      '<path d="M14.5 8.5 11 10.5 9 8.5"/>'
  ),
};

type Geo = {
  samples: Sample[];
  smoothed: Sample[];
  total: number;
  places: LieuPlace[];
  timeline: Timeline;
};

/** Ajoute fond 3D, tracé, bornes et halo du coureur au style courant (appelé à chaque style.load). */
function setupStyle(
  gl: GL,
  map: GLMap,
  b: Basemap,
  o: { custom: boolean; lightPreset: string; theme: string; showKmMarkers: boolean }
) {
  const isStandard = !o.custom && gl.isStandard(b);
  const isSatellite = !o.custom && gl.isSatellite(b);
  const em = (props: Record<string, unknown>) =>
    gl.supportsEmissive ? props : Object.fromEntries(Object.entries(props).filter(([k]) => !k.endsWith("emissive-strength")));

  if (isStandard) {
    try {
      map.setConfigProperty("basemap", "lightPreset", o.lightPreset);
      map.setConfigProperty("basemap", "theme", o.theme);
      map.setConfigProperty("basemap", "show3dObjects", true);
      map.setConfigProperty("basemap", "showPointOfInterestLabels", false);
    } catch (e) {
      console.warn("[MarathonFlyover] config Standard non appliquée", e);
    }
  } else {
    if (gl.supportsFog) {
      map.setFog(
        isSatellite
          ? { color: "#1a2238", "high-color": "#2b3a63", "horizon-blend": 0.06, "space-color": "#05070d", "star-intensity": 0 }
          : b === "light"
            ? { color: "#e9edf3", "high-color": "#c7d3e6", "horizon-blend": 0.05, "space-color": "#9fb3d1", "star-intensity": 0 }
            : { color: BG, "high-color": "#101a33", "horizon-blend": 0.08, "space-color": "#05070d", "star-intensity": 0 }
      );
    }
    addBuildings(gl, map, b);
  }

  const slotMid = isStandard ? { slot: "middle" as const } : {};
  const slotTop = isStandard ? { slot: "top" as const } : {};
  const labelLayer = isStandard ? undefined : firstLabelLayer(map);

  if (!map.getSource("parcours")) map.addSource("parcours", { type: "geojson", data: PARCOURS, lineMetrics: true });
  // Liseré blanc + trait bleu opaque. `emissive-strength: 1` (Mapbox) = couleur pleine quel que soit l'éclairage.
  map.addLayer(
    {
      id: "parcours-casing",
      type: "line",
      source: "parcours",
      ...slotMid,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: em({
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 8, 17, 13],
        "line-gradient": gradient(0, CASING),
        "line-emissive-strength": 1,
      }),
    } as mapboxgl.AnyLayer,
    labelLayer
  );
  map.addLayer(
    {
      id: "parcours-line",
      type: "line",
      source: "parcours",
      ...slotMid,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: em({
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 14, 5, 17, 8],
        "line-gradient": gradient(0),
        "line-emissive-strength": 1,
      }),
    } as mapboxgl.AnyLayer,
    labelLayer
  );

  if (o.showKmMarkers) addKmLayers(gl, map, slotTop, em);

  // halo au sol sous le coureur (le coureur lui-même est un marqueur HTML, voir startFlyover)
  const c0 = PARCOURS.geometry.coordinates[0] ?? [0, 0];
  if (!map.getSource("runner")) map.addSource("runner", { type: "geojson", data: pointFC([c0[0] ?? 0, c0[1] ?? 0]) });
  map.addLayer({
    id: "runner-halo",
    type: "circle",
    source: "runner",
    ...slotTop,
    paint: em({ "circle-radius": 22, "circle-color": VDN_BLUE, "circle-opacity": 0.35, "circle-blur": 0.9, "circle-emissive-strength": 1 }),
  } as mapboxgl.AnyLayer);
}

/** Bornes km 1…N (optionnelles). */
function addKmLayers(gl: GL, map: GLMap, slotTop: { slot?: "top" }, em: (p: Record<string, unknown>) => Record<string, unknown>) {
  if (!map.getSource("km")) map.addSource("km", { type: "geojson", data: KM });
  map.addLayer({
    id: "km-circle",
    type: "circle",
    source: "km",
    ...slotTop,
    filter: ["<=", ["get", "km"], 0],
    paint: em({
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 6, 15, 11],
      "circle-color": "#ffffff",
      "circle-stroke-color": VDN_BLUE,
      "circle-stroke-width": 3,
      "circle-pitch-alignment": "map",
      "circle-emissive-strength": 1,
    }),
  } as mapboxgl.AnyLayer);
  map.addLayer({
    id: "km-label",
    type: "symbol",
    source: "km",
    ...slotTop,
    filter: ["<=", ["get", "km"], 0],
    layout: {
      "text-field": ["get", "label"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 11, 9, 15, 12],
      "text-font": gl.fontStack,
      "text-allow-overlap": true,
      "text-pitch-alignment": "map",
    },
    paint: { "text-color": VDN_BLUE },
  } as mapboxgl.AnyLayer);
}

/** Mode exploration : tout le tracé, toutes les bornes, pas de coureur. */
function showEverything(map: GLMap, geo: Geo) {
  if (!map.getLayer("parcours-line")) return;
  map.setPaintProperty("parcours-line", "line-gradient", gradient(1));
  map.setPaintProperty("parcours-casing", "line-gradient", gradient(1, CASING));
  if (map.getLayer("km-circle")) {
    map.setFilter("km-circle", null);
    map.setFilter("km-label", null);
  }
  map.setLayoutProperty("runner-halo", "visibility", "none");
  void geo;
}

function firstLabelLayer(map: GLMap): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return map.getStyle().layers?.find((l) => l.type === "symbol" && (l.layout as any)?.["text-field"])?.id;
}

/** Bâtiments extrudés aux couleurs VDN, depuis la source de bâtiments du style courant. */
function addBuildings(gl: GL, map: GLMap, b: Basemap) {
  if (map.getLayer("vdn-3d-buildings")) return;
  const src = gl.buildings(map, b);
  if (!src) return;
  for (const id of src.hideLayers) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  const look = gl.isSatellite(b) ? "satellite" : b === "light" || (gl.engine === "maplibre" && b === "standard") ? "light" : "dark";
  const RAMPS: Record<typeof look, [string, string, string]> = {
    satellite: ["#8d93a0", "#a7adba", "#c4c9d4"],
    light: ["#d3d8e2", "#e1e5ec", "#eef0f4"],
    dark: ["#18233d", "#24345c", "#33487f"],
  };
  const ramps = RAMPS[look];
  map.addLayer(
    {
      id: "vdn-3d-buildings",
      source: src.source,
      "source-layer": src.sourceLayer,
      filter: gl.engine === "mapbox" ? ["==", "extrude", "true"] : ["!=", ["get", "hide_3d"], true],
      type: "fill-extrusion",
      minzoom: 13,
      paint: {
        "fill-extrusion-color": ["interpolate", ["linear"], src.height, 0, ramps[0], 30, ramps[1], 80, ramps[2]],
        "fill-extrusion-height": src.height,
        "fill-extrusion-base": src.base,
        "fill-extrusion-opacity": look === "satellite" ? 0.7 : 0.92,
        "fill-extrusion-vertical-gradient": true,
      },
    } as mapboxgl.AnyLayer,
    firstLabelLayer(map)
  );
}

/** Dégradé « parcouru / pas encore » : couleur pleine jusqu'à la fraction p, transparent ensuite. */
function gradient(p: number, color = VDN_BLUE): mapboxgl.Expression {
  const eps = 0.0005;
  if (p >= 1) return ["interpolate", ["linear"], ["line-progress"], 0, color, 1, color];
  const a = Math.max(eps, Math.min(1 - eps * 2, p)); // stops strictement croissants
  return [
    "interpolate", ["linear"], ["line-progress"],
    0, color,
    a, color,
    a + eps, "rgba(0,0,0,0)",
    1, "rgba(0,0,0,0)",
  ];
}

function pointFC(c: [number, number]): FeatureCollection<Point> {
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }] };
}

/**
 * Caméra de survol : cible = point lissé `lookAhead` m devant le coureur, au sol ;
 * position = point lissé à `altitude` m, reculée de sorte que l'angle vaille `pitch`.
 * Lissage exponentiel (τ = 0,8 s) pour absorber virages serrés et demi-tours.
 */
function applyCamera(
  gl: GL,
  map: GLMap,
  geo: Geo,
  d: number,
  a: { camPos: [number, number] | null; camTgt: [number, number] | null },
  p: CamParams,
  dt: number
) {
  const pos = sampleAt(geo.smoothed, d - lookBehindOf(p));
  const tgt = sampleAt(geo.smoothed, d + p.lookAhead);
  const k = a.camPos ? 1 - Math.exp(-dt / 0.8) : 1;
  a.camPos = a.camPos ? lerp(a.camPos, pos, k) : pos;
  a.camTgt = a.camTgt ? lerp(a.camTgt, tgt, k) : tgt;
  gl.lookFromTo(map, a.camPos, p.altitude, a.camTgt);
}

function lerp(a: [number, number], b: [number, number], k: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}

/** Mode survol : révélation progressive. */
function updateLayers(map: GLMap, geo: Geo, d: number) {
  if (!map.getLayer("parcours-line")) return;
  map.setPaintProperty("parcours-line", "line-gradient", gradient(d / geo.total));
  map.setPaintProperty("parcours-casing", "line-gradient", gradient(d / geo.total, CASING));
  if (map.getLayer("km-circle")) {
    const kmDone = Math.floor(d / 1000);
    map.setFilter("km-circle", ["<=", ["get", "km"], kmDone]);
    map.setFilter("km-label", ["<=", ["get", "km"], kmDone]);
  }
  map.setLayoutProperty("runner-halo", "visibility", "visible");
  (map.getSource("runner") as mapboxgl.GeoJSONSource | undefined)?.setData(pointFC(sampleAt(geo.samples, d)));
}

function makeMarker(gl: GL, map: GLMap, p: LieuPlace, onClick?: (p: LieuPlace) => void): GLMarker {
  const el = document.createElement("div");
  const type = p.type ?? "lieu";
  el.className = `mf-marker mf-${type}` + (onClick ? " clickable" : "");
  const label = type === "ravito" && p.km != null ? `km ${p.km}` : p.nom;
  el.innerHTML = `<div class="mf-bubble">${ICONS[type] ?? ""}<span>${label}</span></div>`;
  if (onClick) el.addEventListener("click", (e) => { e.stopPropagation(); onClick(p); });
  return gl.marker(el, "bottom").setLngLat(p.coord).addTo(map);
}

/** Exploration : tous les marqueurs, cliquables. */
function ensureAllMarkers(gl: GL, map: GLMap, geo: Geo, markers: Map<string, GLMarker>, onClick: (p: LieuPlace) => void) {
  markers.forEach((m) => m.remove());
  markers.clear();
  for (const p of geo.places) markers.set(p.id, makeMarker(gl, map, p, onClick));
}

/** Survol : la bulle surgit quand le coureur arrive dessus (60 m avant) et reste ensuite. */
function revealPlaces(
  gl: GL,
  map: GLMap,
  geo: Geo,
  d: number,
  markers: Map<string, GLMarker>,
  setActive: (p: LieuPlace | null) => void
) {
  let active: LieuPlace | null = null;
  for (const p of geo.places) {
    if (d >= p.d - 60 && !markers.has(p.id)) markers.set(p.id, makeMarker(gl, map, p));
    if (d >= p.d - 60 && d <= p.d + 400) active = p;
  }
  setActive(active);
}

function setInteractive(gl: GL, map: GLMap, on: boolean) {
  const handlers = [map.dragPan, map.scrollZoom, map.dragRotate, map.touchZoomRotate, map.keyboard, map.doubleClickZoom, map.boxZoom];
  handlers.forEach((h) => (on ? h.enable() : h.disable()));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = map as any;
  const has = store._vdnNav as mapboxgl.IControl | undefined;
  if (on && !has) {
    const nav = gl.navigationControl();
    map.addControl(nav, "bottom-right");
    store._vdnNav = nav;
  } else if (!on && has) {
    map.removeControl(has);
    store._vdnNav = undefined;
  }
}

const CSS = `
.mf-root{position:relative;width:100%;background:${BG};font-family:"Source Sans 3","Helvetica Neue",Arial,sans-serif;color:#fff;overflow:hidden}
.mf-map{position:absolute;inset:0}
.mf-top{position:absolute;top:0;left:0;right:0;padding:14px 16px 0;pointer-events:none;background:linear-gradient(${BG}cc,transparent)}
.mf-title{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.mf-kicker{font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:13px;color:#cfd8ea}
.mf-hint{font-size:12px;color:#8a97b3}
.mf-timeline{position:absolute;left:16px;right:16px;bottom:66px;display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(11,18,32,.82);backdrop-filter:blur(6px);border-radius:999px}
.mf-tl-label{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#cfd8ea;flex:none}
.mf-tl-track{position:relative;flex:1;height:18px;cursor:pointer}
.mf-tl-track::before{content:"";position:absolute;left:0;right:0;top:7px;height:4px;border-radius:2px;background:rgba(255,255,255,.22)}
.mf-tl-fill{position:absolute;left:0;top:7px;height:4px;border-radius:2px;background:${VDN_BLUE};transition:width .15s linear}
.mf-tl-tick{position:absolute;top:5px;width:2px;height:8px;margin-left:-1px;background:rgba(255,255,255,.55);border-radius:1px;pointer-events:none}
.mf-tl-knob{position:absolute;top:2px;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:#fff;border:3px solid ${VDN_BLUE};box-shadow:0 1px 4px rgba(0,0,0,.4);transition:left .15s linear;pointer-events:none}
.mf-flyover .mf-card{bottom:124px}
.mf-basemaps{position:absolute;top:58px;right:16px;display:flex;background:rgba(11,18,32,.85);backdrop-filter:blur(6px);border-radius:999px;padding:3px;gap:2px}
.mf-seg{border:0;background:transparent;color:#cfd8ea;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;cursor:pointer}
.mf-seg.on{background:#fff;color:${BG}}
.mf-card{position:absolute;left:16px;bottom:76px;max-width:340px;padding:12px 40px 12px 16px;background:rgba(11,18,32,.88);backdrop-filter:blur(6px);border-left:4px solid ${VDN_BLUE};border-radius:4px;animation:mf-in .4s ease}
.mf-card-close{position:absolute;top:6px;right:8px;border:0;background:transparent;color:#8a97b3;font-size:20px;line-height:1;cursor:pointer}
.mf-card-close:hover{color:#fff}
.mf-card-nom{font-size:19px;font-weight:700;margin:2px 0 4px}
.mf-card-desc{font-size:14px;line-height:1.35;color:#d5dcea}
.mf-card-hors{font-size:12px;color:#8a97b3;margin-top:4px;font-style:italic}
@keyframes mf-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.mf-controls{position:absolute;left:16px;right:16px;bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mf-btn{border:1px solid rgba(255,255,255,.35);background:rgba(11,18,32,.8);color:#fff;padding:9px 16px;border-radius:999px;font-size:14px;font-weight:600;cursor:pointer}
.mf-btn:hover{border-color:#fff}
.mf-btn.primary{background:${VDN_BLUE};border-color:${VDN_BLUE}}
.mf-btn.ghost{background:transparent}
.mf-btn.small{padding:6px 10px;font-size:12px}
.mf-btn.on{background:#fff;color:${BG};border-color:#fff}
.mf-rates{display:flex;gap:4px}
.mf-btn.icon{display:inline-flex;align-items:center;gap:6px;padding:8px 12px}
.mf-btn.icon svg{width:16px;height:16px;display:block}
.mf-fs{margin-left:auto}
.mf-root:fullscreen{width:100vw;height:100vh;border-radius:0}
@media (max-width:600px){.mf-fs-label{display:none}.mf-btn.icon{padding:9px}}
.mf-loading{font-size:13px;color:#cfd8ea}
.mf-error{font-size:13px;color:#ffb4a8;background:rgba(11,18,32,.85);padding:8px 12px;border-radius:6px}
/* Bulles : carré arrondi + pointe, une seule forme (l'ombre portée suit le contour complet). */
.mf-marker{padding-bottom:8px;pointer-events:none;animation:mf-in .5s ease;filter:drop-shadow(0 2px 4px rgba(0,0,0,.45))}
.mf-marker.clickable{pointer-events:auto;cursor:pointer}
.mf-bubble{position:relative;display:flex;align-items:center;gap:5px;background:#fff;color:#1c2a44;font:700 12px/1 "Source Sans 3","Helvetica Neue",Arial,sans-serif;padding:6px 9px;border-radius:7px;white-space:nowrap;transition:background .15s,color .15s}
.mf-bubble::after{content:"";position:absolute;left:50%;bottom:-7px;margin-left:-7px;border:7px solid transparent;border-top-color:#fff;border-bottom:0;transition:border-top-color .15s}
.mf-bubble svg{flex:none;color:${VDN_BLUE}}
.mf-marker.clickable:hover .mf-bubble{background:${VDN_BLUE};color:#fff}
.mf-marker.clickable:hover .mf-bubble::after{border-top-color:${VDN_BLUE}}
.mf-marker.clickable:hover .mf-bubble svg{color:#fff}
.mf-runner{width:36px;height:36px;border-radius:50%;background:#fff;color:${VDN_BLUE};display:grid;place-items:center;box-shadow:0 2px 6px rgba(0,0,0,.45);z-index:3}
.mf-runner svg{width:22px;height:22px}
.mf-depart,.mf-arrivee{z-index:2}
.mf-depart .mf-bubble,.mf-arrivee .mf-bubble{color:#fff;font-size:13px;text-transform:uppercase;letter-spacing:.06em;padding:7px 11px}
.mf-depart .mf-bubble svg,.mf-arrivee .mf-bubble svg{color:#fff}
.mf-depart .mf-bubble{background:${DEPART_COLOR}}
.mf-depart .mf-bubble::after{border-top-color:${DEPART_COLOR}}
.mf-arrivee .mf-bubble{background:${ARRIVEE_COLOR}}
.mf-arrivee .mf-bubble::after{border-top-color:${ARRIVEE_COLOR}}
.mf-depart.clickable:hover .mf-bubble{background:#fff;color:${DEPART_COLOR}}
.mf-depart.clickable:hover .mf-bubble::after{border-top-color:#fff}
.mf-depart.clickable:hover .mf-bubble svg{color:${DEPART_COLOR}}
.mf-arrivee.clickable:hover .mf-bubble{background:#fff;color:${ARRIVEE_COLOR}}
.mf-arrivee.clickable:hover .mf-bubble::after{border-top-color:#fff}
.mf-arrivee.clickable:hover .mf-bubble svg{color:${ARRIVEE_COLOR}}
.mf-debug{position:absolute;top:104px;right:16px;width:300px;padding:12px;background:rgba(11,18,32,.88);backdrop-filter:blur(6px);border-radius:6px;font-size:12px;display:flex;flex-direction:column;gap:8px}
.mf-slider{display:grid;grid-template-columns:82px 1fr 56px;align-items:center;gap:6px}
.mf-slider input{width:100%;accent-color:${VDN_BLUE}}
.mf-slider output{text-align:right;font-variant-numeric:tabular-nums}
.mf-debug-out{color:#8a97b3;font-size:11px;line-height:1.4;user-select:all}
.mapboxgl-ctrl-bottom-right,.maplibregl-ctrl-bottom-right{bottom:60px}
@media (max-width:600px){.mf-card{max-width:calc(100% - 32px);bottom:96px}.mf-flyover .mf-card{bottom:150px}.mf-hint{display:none}.mf-debug{display:none}.mf-basemaps{top:50px}}
`;
