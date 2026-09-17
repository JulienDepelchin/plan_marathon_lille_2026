import { useEffect, useRef } from "react";
import MarathonFlyover, { type Engine, type FlyoverControl } from "./components/MarathonFlyover";

/**
 * Page de démo locale (atelier). Dans Lovable, importez directement <MarathonFlyover />.
 *
 * Paramètres d'URL :
 *   ?engine=maplibre   version sans Mapbox (OpenFreeMap + orthophoto IGN)
 *   ?export=1          mode export vidéo : commandes masquées, habillage agrandi, API window.__mf
 *                      pour scripts/export-video.mjs — n'existe que dans cette page, pas dans le composant
 */
export default function App() {
  const token = import.meta.env["VITE_MAPBOX_TOKEN"] as string | undefined;
  const params = new URLSearchParams(window.location.search);
  const engine: Engine = params.get("engine") === "maplibre" ? "maplibre" : "mapbox";
  const exportMode = params.get("export") === "1";

  if (!token && engine === "mapbox") {
    return (
      <div style={{ color: "#fff", fontFamily: "system-ui", padding: 32 }}>
        <h2>Token Mapbox manquant</h2>
        <p>
          Copiez <code>.env.example</code> en <code>.env</code> et renseignez{" "}
          <code>VITE_MAPBOX_TOKEN</code> (voir README).
        </p>
      </div>
    );
  }

  if (exportMode) return <ExportPage engine={engine} token={token} />;

  // debug : panneau de calibrage (fond de carte, caméra). À retirer pour la publication.
  return <MarathonFlyover engine={engine} mapboxToken={token} debug />;
}

/** Mode export : branche window.__mf sur la poignée de pilotage et habille pour le 1080×1920. */
function ExportPage({ engine, token }: { engine: Engine; token: string | undefined }) {
  const control = useRef<FlyoverControl | null>(null);
  useEffect(() => {
    const w = window as unknown as { __mf?: FlyoverControl };
    // proxy : la poignée est (ré)assignée par le composant quand la carte est prête
    w.__mf = {
      isReady: () => control.current?.isReady() ?? false,
      total: () => control.current?.total() ?? 0,
      setRate: (r) => control.current?.setRate(r),
      start: (manual = true) => control.current?.start(manual) ?? false,
      step: (dt) => control.current?.step(dt) ?? Promise.resolve({ done: true, t: 0 }),
      finish: () => control.current?.finish(),
    };
    return () => {
      delete w.__mf;
    };
  }, []);

  // réglages caméra passés dans l'URL par scripts/export-video.mjs (préréglage vidéo ≠ site)
  const q = new URLSearchParams(window.location.search);
  const num = (k: string, def: number) => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) ? v : def;
  };
  return (
    <div className="export-root">
      <style>{EXPORT_CSS}</style>
      <MarathonFlyover
        engine={engine}
        mapboxToken={token}
        startMode="explore"
        controlRef={control}
        cameraAltitude={num("altitude", 700)}
        cameraPitch={num("pitch", 60)}
        lookAhead={num("lookahead", 120)}
        smoothingWindow={num("smoothing", 350)}
        curveSlowdown={num("slowdown", 0.65)}
        curveLift={num("lift", 0.6)}
      />
    </div>
  );
}

/* Commandes masquées ; bandeau, bulles, coureur et timeline agrandis ~1,7× (zoom CSS, Chromium) pour un
   1080 px de large regardé sur un téléphone. Attribution Mapbox/OSM conservée (obligatoire). */
const EXPORT_CSS = `
.export-root,.export-root .mf-root{height:100vh}
.export-root .mf-controls,.export-root .mf-basemaps,.export-root .mf-hint,.export-root .mf-splash,.export-root .mf-card-close,
.export-root .mapboxgl-ctrl-top-right,.export-root .maplibregl-ctrl-top-right{display:none}
.export-root .mf-top{padding:24px 22px 40px;background:linear-gradient(rgba(11,18,32,.85),transparent)}
.export-root .mf-kicker{font-size:24px;letter-spacing:.1em}
.export-root .mf-timeline{bottom:40px;left:24px;right:24px;zoom:1.7}
.export-root .mf-card{bottom:150px;left:24px;max-width:560px;zoom:1.6}
.export-root .mf-bubble{zoom:1.6}
.export-root .mf-runner{width:56px;height:56px}
.export-root .mf-runner svg{width:34px;height:34px}
.export-root .mapboxgl-ctrl-bottom-left,.export-root .maplibregl-ctrl-bottom-left,
.export-root .mapboxgl-ctrl-bottom-right,.export-root .maplibregl-ctrl-bottom-right{bottom:120px}
`;
