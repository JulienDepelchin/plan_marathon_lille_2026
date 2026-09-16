# Vérification du GPX — Marathon de Lille 2026

Fichier analysé : `raw/Marathon de Lille 2026 ⚜️🇫🇷.gpx` (16/09/2026)

## Identité du fichier — à noter
- Ce n'est **pas un export de l'organisateur** : c'est une **route Strava** (`creator="StravaGPX"`) dessinée par un athlète (« Abda Oubaha », route 3534881282253069704), sur fond OpenStreetMap. À vérifier auprès de l'organisation avant de le présenter comme « tracé officiel ».
- 882 points, 1 segment, altitude présente, **aucun horodatage** (route dessinée, pas une trace enregistrée). La « chronologie » est donc l'ordre des points.
- Longueur recalculée : **43,68 km** (haversine) / 43,83 km (Lambert-93). Strava affiche 43,5 km. Écart avec 42,195 km : ~1,5 km, cohérent avec un tracé dessiné à la main qui suit l'axe des rues (les routes Strava s'accrochent au réseau OSM, souvent au milieu de la chaussée, et ajoutent des détours aux carrefours).
- D+ ≈ 135 m (alt. 21 → 52 m). Parcours plat.

## Cohérence de l'ordre des points — RAS sur l'essentiel
| Test | Résultat |
|---|---|
| Distance cumulée strictement croissante | ✅ oui, pour les 881 segments |
| Doublons / segments nuls (< 0,5 m) | ✅ aucun |
| Trous GPS (segments > 150 m) | ✅ aucun (max 100 m, médiane 54 m) |
| Départ / arrivée | Départ rue d'Hazebrouck (Porte de Paris, 50.62902 / 3.06676) → arrivée esplanade du Champ de Mars (50.63972 / 3.05083). 1,6 km à vol d'oiseau : le parcours n'est pas une boucle fermée. |

## Anomalies détectées (mineures, aucune ne casse le tracé)

### 1. Un éperon aller-retour de 60 m au km 41,88 — **le seul vrai artefact**
Points 847→853 : le tracé s'engage 30 m dans le boulevard de la Liberté (50.62819 / 3.06852, à côté de la Porte de Paris) puis **revient exactement sur ses pas** (les points 851-853 sont les copies miroir de 849-847). Typique d'un point d'ancrage Strava cliqué légèrement à côté de la route. Impact : demi-tour instantané de 180° pour la caméra. **Traité par le lissage caméra** (fenêtre de 60 m) — le tracé affiché reste brut comme demandé. Option : supprimer les points 850-853 dans `scripts/gpx_to_geojson.py` si vous voulez un tracé propre.

### 2. Quatre micro-zigzags aux carrefours (km 1,85 ; 14,17 ; 20,92 ; 28,3-28,6)
Segments de 0,7 à 2 m avec un angle > 150°. Ce sont des virages à angle très fermé (épingles) doublés d'un point parasite, ou un léger « escalier » d'une rive à l'autre de la chaussée. Sans conséquence : le rééchantillonnage tous les 5 m + lissage les efface.

### 3. Chevauchements de segments : normaux, mais avec une conséquence éditoriale
Le tracé **emprunte deux fois les mêmes rues** dans le centre de Lille :
- km 0,2 → 4,1 (aller) = km 37,3 → 43,5 (retour), soit ~4 km partagés ;
- km 40,6 → 41,5 = km 42,1 → 43,1 : aller-retour de 950 m autour de la Porte de Paris / Hôtel de ville, avec une petite boucle de 540 m entre les deux.

Ce n'est pas une erreur du fichier (c'est le dessin du parcours), mais **les lieux du centre sont donc traversés deux fois** : Grand-Place km 2,9 **et** 39,9 ; Vieille Bourse / Opéra km 2,8 **et** 39,9 ; Gare Lille-Flandres km 2,5 et 39,5. Il faut choisir à quel passage le marqueur apparaît (`kmHint` dans `src/data/lieux.ts`).

Les autres « chevauchements » repérés (km 4,6 ; 5,7 ; 6,7 ; 9,7 ; 41,6) sont des points à 2-5 m les uns des autres autour de terre-pleins / ronds-points : bruit de dessin, sans impact.

## Position des lieux emblématiques demandés
| Lieu | Distance au tracé | Passage(s) |
|---|---|---|
| Grand-Place | 31 m | km 2,87 et 39,94 |
| Vieille Bourse | 40 m | km 2,78 et 39,85 |
| Palais des Beaux-Arts | **71 m** (bd de la Liberté) | km 41,20 et 42,44 — **pas à l'aller**, le tracé ne passe pas place de la République |
| Citadelle (Porte Royale) | **430 m** | jamais au bord du tracé. L'arrivée (Champ de Mars) est au pied de la Citadelle, c'est ce qu'on peut dire. |

Autres passages remarquables : Jardin Vauban (12 m, km 4,3 et 7,5), Opéra (30 m), Porte de Paris (km 0, 41,5, 42,1), Gare Lille-Flandres (78 m), centre de Seclin (69 m, km 26 — point le plus au sud), Faches-Thumesnil centre (km 33,7).

---

# Tracé v2 — `raw/Marathon de Lille.gpx` (retouche manuelle, 16/09/2026 après-midi)

Retouché par Julien dans Strava à partir de la carte officielle (`raw/marathon-6aa9438c18aa3.png`,
Trek Marathon de Lille, 25/10/2026). L'ancien fichier est dans `raw/archive/`.

**42,559 km**, 1 144 points bruts → **989 après suppression des doublons exacts** (faite par le script).

## Cohérence
| Test | Résultat |
|---|---|
| Distance cumulée strictement croissante | ✅ après dédoublonnage (155 points en double exact, inoffensifs) |
| Ordre des points | ✅ pas de retour en arrière : les « demi-tours » détectés étaient tous des doublons (segments de 0 m) |
| Trous | ⚠️ 44 segments > 150 m (max 448 m au km 0,37, 438 m au km 39) : segments droits tracés à la main. Sans effet sur la carte tant que la rue est droite ; le rééchantillonnage à 5 m gère le reste |
| Éperons | 1 aller-retour de ~50 m au km 18,83-18,98 (Emmerin), 1 pic de 0,8 m au km 40,72 — négligeables |
| Arrivée | déplacée de 76 m : le tracé s'arrête maintenant à 50.63889 / 3.05091 (esplanade du Champ de Mars) ; la fiche « Arrivée » a été recalée dessus |

## Ce qui a changé par rapport à la v1 (écart > 15 m)
| Secteur | v1 | v2 | Nature |
|---|---|---|---|
| km 9,5 Wazemmes/Moulins | boucle de 379 m | 40 m | boucle supprimée ; **le segment 255→258 coupe en diagonale sur ~150 m, à vérifier sur fond satellite (suit-il une rue ?)** |
| km 13-13,5 | rue droite | escalier de 5 points jusqu'à 65 m de la rue | **tracé à main levée non calé sur la voirie, à reprendre** (cosmétique) |
| km 17,4-17,6 | 215 m | 279 m | rue voisine |
| km 18-20 Emmerin | 1 390 m | 1 200 m, jusqu'à 494 m d'écart | **autre itinéraire**, bien calé sur la voirie |
| km 25,7-26,5 Seclin | 832 m avec détour ouest | 521 m | **autre itinéraire**, bien calé |
| arrivée | — | −76 m | fin déplacée |

Bilan : ~3,4 km de v1 remplacés par ~2,7 km en v2 (−0,7 km), le reste de la différence (−0,4 km) vient des segments droits qui coupent les courbes.

## Bornes km v2 vs carte officielle
km 5 Citadelle ✅ · km 10 Wazemmes ✅ · km 15 entre Faches et Loos (carte officielle : Loos, M147) ≈ · km 20 Noyelles ✅ ·
km 25 Seclin sud ✅ · km 30 Wattignies ✅ · km 35 Lille-Sud/Porte de Douai ✅ · km 40 secteur République ✅.
Cohérent à quelques centaines de mètres près, ce qui est l'ordre de grandeur attendu (42,56 vs 42,195).

## Passages devant les lieux (v2)
Vieille Bourse km 2,8 et 38,7 · Grand-Place km 2,9 et 38,8 · gare Lille-Flandres km 2,4 et 38,3 ·
Beaux-Arts km 40,1 et 41,3 · Porte de Paris km 0, 40,4 et 40,9 · Jardin Vauban km 4,4 et 7,4 · Seclin km 25,4.
