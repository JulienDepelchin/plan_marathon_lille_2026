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
   localhost:5173
   ```
   `localhost` doit être ajouté explicitement, avec le port de Vite (sans port, seuls 80 et 443 passent).
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

1. Dans le projet Lovable, ajouter les dépendances : `mapbox-gl` et `@turf/turf`
   (demander à Lovable « ajoute mapbox-gl et @turf/turf » ou éditer `package.json`).
2. Copier tels quels : `src/components/MarathonFlyover.tsx`, `src/lib/path.ts`, `src/data/` (3 fichiers).
3. Ajouter le token dans les variables d'environnement Lovable : `VITE_MAPBOX_TOKEN=pk.…`
   (Project → Settings → Environment variables). À défaut, le passer en dur en prop — il est public de toute façon.
4. Utiliser le composant :

```tsx
import MarathonFlyover from "@/components/MarathonFlyover";

<MarathonFlyover mapboxToken={import.meta.env.VITE_MAPBOX_TOKEN} height="80vh" />
```

Si `tsconfig` de Lovable refuse l'import JSON, activer `"resolveJsonModule": true`.
Pour un embed iframe dans un article, voir le skill `lovable-iframe` (hauteur fixe obligatoire).

## 4. Réglages (props)

Deux modes. **Exploration** (défaut) : tracé complet, bornes et lieux cliquables (fiche + zoom), vue libre,
sélecteur de fond de carte. **Survol** : caméra qui suit le tracé, accessible par le bouton « Survoler le parcours »
ou en mode initial. Le survol peut donner le tournis : à réserver aux lecteurs qui le demandent.

| Prop | Défaut | Effet |
|---|---|---|
| `startMode` | `"explore"` | `"flyover"` pour démarrer par le survol |
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
3. À chaque image : position caméra = point lissé 180 m derrière le coureur à 150 m d'altitude ;
   cible = point lissé 320 m devant, au sol ; `lookAtPoint` en déduit pitch et bearing.
   Un lissage exponentiel (τ = 0,8 s) absorbe les épingles et le demi-tour du km 41,9.
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
