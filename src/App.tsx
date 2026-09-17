import MarathonFlyover, { type Engine } from "./components/MarathonFlyover";

/**
 * Page de démo locale. Dans Lovable, importez directement <MarathonFlyover />.
 *
 * Paramètres d'URL utiles :
 *   ?engine=maplibre   version sans Mapbox (OpenFreeMap + orthophoto IGN)
 *   ?export=1          mode export vidéo (commandes masquées, API window.__mf) — voir scripts/export-video.mjs
 *   &rate=6            multiplicateur de vitesse du survol en export (défaut 2)
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

  if (exportMode) {
    // la vidéo est cadrée par la taille de la fenêtre du navigateur piloté (1080×1920)
    return <MarathonFlyover engine={engine} mapboxToken={token} exportMode startMode="explore" />;
  }

  // debug : panneau de calibrage (fond de carte, caméra). À retirer pour la publication.
  return <MarathonFlyover engine={engine} mapboxToken={token} debug />;
}
