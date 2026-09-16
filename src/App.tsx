import MarathonFlyover from "./components/MarathonFlyover";

/** Page de démo locale. Dans Lovable, importez directement <MarathonFlyover />. */
export default function App() {
  const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
  if (!token) {
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
  // debug : panneau de calibrage (fond de carte, caméra). À retirer pour la publication.
  return <MarathonFlyover mapboxToken={token} debug />;
}
