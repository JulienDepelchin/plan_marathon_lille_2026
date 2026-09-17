# Marathon de Lille 2026 — carte 3D du parcours

Composant React autonome (Mapbox GL JS 3D + turf.js) : le lecteur explore le tracé en 3D, clique sur
les lieux emblématiques, change de fond de carte ; un survol caméra optionnel suit le tracé du départ
à l'arrivée. Aucun backend.

> Avant toute chose, lire [RAPPORT-GPX.md](RAPPORT-GPX.md) : historique du tracé (v1 route Strava d'un tiers,
> v2 retouchée à la main sur la carte officielle, 42,56 km) et points à vérifier. Le centre de Lille est traversé deux fois.

## Structure

```
raw/Marathon de Lille.gpx    tracé courant (v2) ; raw/archive/ = versions précédentes
raw/marathon-*.png           carte officielle de l'organisateur (référence)
scripts/gpx_to_geojson.py    GPX/KML → GeoJSON (+ dédoublonnage, vérification distance cumulée croissante)
src/data/parcours.json       tracé LineString (points bruts dédoublonnés, ordre conservé)
src/data/km.json             bornes km 1…42 (interpolées sur le tracé)
src/data/lieux.ts            ← lieux emblématiques : LE fichier éditorial à ajuster
src/lib/path.ts              rééchantillonnage turf, lissage, profil de vitesse
src/components/MarathonFlyover.tsx   le composant (carte + caméra + UI)
src/App.tsx, src/main.tsx    page de démo locale (Vite)
```

## 1. Obtenir un token Mapbox gratuit

1. Créer un compte sur <https://account.mapbox.com/auth/signup/> (pas de carte bancaire pour l'offre gratuite).
2. Sur le tableau de bord, section **Access tokens**, copier le *Default public token* (`pk.…`)
   ou créer un token dédié via **Create a token** (garder les scopes par défaut `styles:read`, `fonts:read`, `styles:tiles`).
3. **Scopes** : laisser les *public scopes* cochés par défaut (`styles:tiles`, `styles:read`, `fonts:read`
   sont indispensables) et **aucun secret scope**.
4. **URL restrictions** (ce qui protège réellement le token) — un domaine par ligne, **sans `*`** (non supporté :
   les sous-domaines et sous-chemins sont autorisés automatiquement, tout protocole si aucun n'est précisé) :
   ```
   lavoixdunord.fr
   lovable.app
   lovableproject.com
   localhost:5173
   ```
   `localhost` doit être ajouté explicitement, avec le port de Vite (sans port, seuls 80 et 443 passent).
   `lovableproject.com` est le domaine réel de l'iframe de prévisualisation Lovable : sans lui, le style se charge
   (le tracé s'affiche) mais toutes les tuiles du fond répondent 403.
5. Quota gratuit : 50 000 chargements de carte / mois (un « chargement » = une ouverture de page avec la carte).
   Suivi dans **Statistics** du compte.

Le token est public par nature (il part dans le navigateur) : c'est la restriction d'URL qui le protège.

## 2. Lancer la démo en local

```bash
npm install
cp .env.example .env        # puis coller le token dans VITE_MAPBOX_TOKEN
npm run dev                 # http://localhost:5173
```

Régénérer les données si le GPX change : `npm run data` (Python 3, aucune dépendance).

## 3. Intégrer dans Lovable

Le projet Lovable vit dans son propre dépôt (Lovable ne sait pas importer un dépôt existant) :
<https://github.com/JulienDepelchin/marathon-map-view>. Ce dépôt-ci est l'atelier ; on y travaille,
puis on **exporte** les 5 fichiers de production vers un clone du dépôt Lovable :

```bash
git clone https://github.com/JulienDepelchin/marathon-map-view.git ../marathon-map-view
npm run export -- ../marathon-map-view
cd ../marathon-map-view && git add -A && git commit -m "Mise à jour de la carte" && git push
```

Lovable se resynchronise seul après le push. Le token et la page (`src/routes/index.tsx`) vivent côté Lovable
et ne sont pas écrasés par l'export.

Particularités du template Lovable (TanStack Start, React 19, TypeScript strict) déjà prises en compte :
- **rendu serveur** : Mapbox GL touche `window` à l'import ; le composant est chargé avec
  `ClientOnly` + `lazy()` dans la page, jamais côté serveur ;
- **tsconfig strict** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`…) : ce dépôt utilise les
  mêmes options, donc ce qui compile ici compile là-bas ;
- **iframe** : l'app remplit son cadre (`height="100%"` dans `src/routes/index.tsx`, html/body/#root à 100 %) ;
  la hauteur se décide à un seul endroit, le code d'embed du CMS. Le composant active les gestes coopératifs
  de Mapbox pour ne pas capturer le défilement de l'article. Code d'embed de référence :

```html
<iframe src="https://marathon-lille-2026.lovable.app/" title="Parcours du marathon de Lille 2026"
        width="100%" height="620" style="border:0;display:block" loading="lazy" allow="fullscreen"></iframe>
```

  La colonne d'article fait 600-800 px : le composant y est en mode étroit quel que soit l'écran du lecteur
  (voir le skill `lovable-iframe`).

## 3 bis. Plan B sans Mapbox : `engine="maplibre"`

Mapbox est gratuit jusqu'à **50 000 chargements de carte par mois**, puis 5 $ les 1 000. Le composant embarque
une sortie de secours prête à l'emploi : MapLibre GL JS + tuiles vectorielles **OpenFreeMap** (gratuit, sans clé,
sans limite, usage commercial autorisé, pas de SLA) + orthophoto **IGN Géoplateforme** (sans clé, licence ouverte).

```tsx
<MarathonFlyover engine="maplibre" height="100%" />   // plus besoin de mapboxToken
```

| | Mapbox (défaut) | MapLibre |
|---|---|---|
| Fond « 3D » | Mapbox Standard : bâtiments détaillés, arbres, éclairage | OpenFreeMap *Liberty* + nos extrusions (hauteurs OSM), rendu plus plat |
| Fond « Satellite » | Mapbox Satellite | Orthophoto IGN (meilleure résolution sur la France, pas de noms de rues) |
| Survol, bulles, timeline, gestes coopératifs | identiques | identiques |
| Coût / quota | 50 000 chargements/mois | aucun |

Tout est dans `src/lib/engine.ts` ; seul le moteur choisi est téléchargé (chargement dynamique).
Test local : `http://localhost:5173/?engine=maplibre`. Surveiller **Statistics** dans le compte Mapbox
la semaine du marathon et basculer si nécessaire : une prop à changer dans `src/routes/index.tsx` côté Lovable.

## 3 ter. Export vidéo vertical (1080×1920) du survol

**Outil d'atelier uniquement** : rien de tout ceci n'est dans le composant livré à Lovable. Le composant expose
juste une poignée de pilotage générique (`controlRef`) ; le mode export (commandes masquées, habillage agrandi,
API `window.__mf`) vit dans la page de démo `src/App.tsx`, activé par `?export=1`.

Rendu image par image : un Chromium piloté par Playwright ouvre la démo en mode export, fait avancer l'animation
d'un pas fixe de 1/30 s, attend que Mapbox ait chargé et dessiné (`idle`), capture la page, et envoie les images
à ffmpeg. Fluide et net quelle que soit la machine ; ~1,4 s par image en mode headless (≈ 45 min pour 60 s de vidéo).
Ne pas modifier `src/` pendant un rendu : le rechargement à chaud de Vite interromprait la capture.

```bash
npx playwright install chromium          # une fois (≈150 Mo, sans droits admin)
npm run dev                              # dans un autre terminal
node scripts/export-video.mjs --out sorties/survol-60s.mp4 --rate 6 --duration 60 --headless
```

Options : `--rate` (vitesse du survol : 2 = comme le site ≈ 3 min ; 6 ≈ 64 s), `--duration` (coupe à N s ; 0 = jusqu'à
l'arrivée), `--fps`, `--width/--height`, `--engine maplibre`, `--intro/--outro` (secondes figées au début / à la fin).
Sans `--headless`, une fenêtre Chromium s'ouvre et utilise la carte graphique (plus rapide).
Les vidéos vont dans `sorties/` (ignoré par git). Attribution Mapbox/OSM conservée dans l'image (obligatoire).

## 4. Réglages (props)

Trois états. **Accueil** (défaut) : vue d'ensemble du parcours, gros bouton play au centre pour lancer le survol, ou lien pour explorer directement. **Survol** : caméra qui suit le tracé, timeline, bouton « Explorer la carte » à tout moment. **Exploration** : tracé complet, points cliquables (fiche + zoom), vue libre, sélecteur de fond.

| Prop | Défaut | Effet |
|---|---|---|
| `startMode` | `"flyover"` | écran d'accueil avec gros bouton play (survol) et lien « Explorer la carte librement » ; `"explore"` = exploration directe ; `"autoplay"` = survol immédiat |
| `showFlyoverButton` | `true` | `false` pour retirer complètement le survol |
| `basemaps` | `["standard","standard-satellite"]` | fonds proposés au lecteur (ordre des boutons ; le premier est le fond initial). Aussi disponibles : `"light"`, `"dark"`, `"satellite"` (classique). Les fonds satellite n'ont pas de bâtiments 3D : la vue passe à plat (pitch 0) quand on les choisit |
| `basemap` | premier de `basemaps` | fond initial |
| `lightPreset` | `"day"` | éclairage des fonds Standard : `dawn` (doré), `day`, `dusk` (crépuscule, sombre), `night` |
| `theme` | `"default"` | rendu des fonds Standard : `faded` (désaturé, très clair, fait ressortir le tracé), `monochrome` (gris) |
| `mapStyle` | — | URL d'un style Mapbox Studio personnalisé (désactive le sélecteur) |
| `baseSpeed` | `120` m/s | survol : vitesse de croisière à ×1 ; le survol démarre à **×2** (≈ 3 min), le lecteur peut passer à ×1 ou ×4 |
| `slowSpeed` | `40` m/s | survol : vitesse dans les zones de lieux |
| `slowRadius` | `300` m | survol : rayon de ralentissement autour de chaque lieu |
| `cameraAltitude` | `500` m | survol : hauteur de la caméra |
| `cameraPitch` | `70` ° | survol : inclinaison (0 = du dessus, 80 = rasante). Le recul derrière le coureur en découle : altitude·tan(pitch) − lookAhead (≈ 1 110 m avec les défauts) |
| `lookAhead` | `260` m | survol : point visé devant le coureur ; le tracé se dessine jusque-là |
| `showKmMarkers` | `false` | bornes km 1…N sur le tracé (masquées : notre mesure diffère de celle de l'organisateur) |
| `cooperativeGestures` | `true` | zoom molette avec Ctrl/⌘ et déplacement à deux doigts : évite que la carte capture le défilement de l'article en iframe |
| `showFullscreenButton` | `true` | bouton « Plein écran » (API Fullscreen sur le composant ; en iframe, `allow="fullscreen"` obligatoire ; sur iPhone, ouvre la carte dans un nouvel onglet) |
| `smoothingWindow` | `120` m | survol : lissage de la trajectoire caméra (virages, demi-tours) |
| `lieux` | `LIEUX` | liste alternative de lieux |
| `debug` | `false` | curseurs de calibrage de la caméra de survol (ne pas publier) |
| `onFinish` | — | callback fin de survol |

Le changement de fond passe par `map.setStyle()` : la vue en cours et les marqueurs sont conservés.
En survol, une timeline Départ → Arrivée (ticks = ravitos) remplace le bandeau ; un clic dessus déplace le coureur.

## 5. Comment marche la caméra

Inspiré de l'exemple Mapbox « Animate the camera along a path » (FreeCamera API) :

1. `turf.along` rééchantillonne le tracé **tous les 5 m** (~8 500 points au lieu des 989 du GPX, espacés de 0,1 à 450 m).
2. Cette polyligne est lissée (moyenne glissante ±120 m, deux passes) pour la **trajectoire caméra uniquement** ;
   le tracé affiché reste brut.
3. À chaque image : cible = point lissé 260 m devant le coureur, au sol ; position caméra = point lissé
   à 500 m d'altitude, reculée de `altitude·tan(pitch) − 260` m (≈ 1 110 m à 70°) ; `lookAtPoint` en déduit
   le cap. Un lissage exponentiel (τ = 0,8 s) absorbe les épingles.
4. La vitesse n'est pas constante : profil `buildTimeline` avec ralentissement smoothstep autour des lieux.

## 6. Points qui demandent un choix éditorial

Rien n'a été tranché à votre place ; les valeurs actuelles sont des propositions.

1. **Points affichés** : départ, ravitaillements (tous les 5 km, du 5 au 40) et arrivée, posés par distance
   sur le tracé (`km` dans `src/data/lieux.ts`), en bulles avec picto (bouteille, drapeaux). Les ravitos
   sont placés sur *notre* mesure du tracé (42,46 km) : avec l'écart de 0,3 km sur 42,195, ils peuvent être décalés
   de 100 à 300 m par rapport aux vrais ; à recaler quand l'organisateur communiquera ses emplacements.
   Des monuments peuvent être ajoutés par coordonnées (`coord` + `kmHint` pour choisir aller/retour :
   Grand-Place km 2,9 / 38,8, Vieille Bourse 2,8 / 38,7, Beaux-Arts 40,1 / 41,3).
2. **Texte des fiches ravitos** : vides pour l'instant (`description` facultative) — quoi y mettre ? eau / solide,
   commune, point de repère ?
3. **Garder le survol ?** Il donne le tournis à certains lecteurs ; l'exploration libre est désormais le mode par
   défaut et le survol n'est qu'un bouton (`showFlyoverButton={false}` pour le retirer). S'il reste : 120 m/s = ~6,5 min,
   long ; un mode « temps forts » (seulement les 500 m autour des lieux) est faisable.
4. **Le Palais des Beaux-Arts** n'est pas au bord du tracé (70 m, bd de la Liberté, au retour seulement). Le garder ?
5. **Deux endroits du tracé v2 à vérifier sur fond satellite** (voir RAPPORT-GPX.md) : la diagonale du km 9,5
   (Wazemmes/Moulins, suit-elle une rue ?) et l'« escalier » du km 13-13,5, tracé à main levée à 65 m de la voirie.
6. **Texte des fiches** : rédigé vite pour la démo, à réécrire selon la charte (`style-vdn`).
7. **Style de fond** : dark-v11 + extrusions maison (couleurs bleu nuit). Alternative : le style Mapbox Standard
   (`mapbox://styles/mapbox/standard`, préréglage `night`) qui a de meilleurs bâtiments 3D (toits, repères) mais
   moins de contrôle sur les couleurs.
