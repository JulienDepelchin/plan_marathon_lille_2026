"""
Convertit le tracé brut du marathon en fichiers GeoJSON prêts pour le composant.

Usage :  python scripts/gpx_to_geojson.py [chemin/vers/fichier]
         (sans argument : premier .gpx ou .kml trouvé dans raw/, les .gpx d'abord)

Formats acceptés :
  - GPX trace  (<trk><trkseg><trkpt>)   — plusieurs segments : concaténés dans l'ordre
  - GPX route  (<rte><rtept>)
  - KML        (<LineString><coordinates>, ou <gx:Track><gx:coord>)

Sorties :
  src/data/parcours.json  — LineString du tracé (points bruts, ordre conservé)
  src/data/km.json        — FeatureCollection des points kilométriques (1..N)
Aucune dépendance hors bibliothèque standard.
"""
import bisect
import glob
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET

# console Windows en cp1252 : ne pas planter sur les emojis du nom de fichier
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_input() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    for pattern in ("*.gpx", "*.kml"):
        files = sorted(glob.glob(os.path.join(ROOT, "raw", pattern)))
        if files:
            return files[0]
    sys.exit("Aucun .gpx ni .kml dans raw/")


def local(tag: str) -> str:
    """Nom de balise sans espace de noms."""
    return tag.rsplit("}", 1)[-1]


def parse(path: str):
    """Retourne (nom, [(lon, lat), ...]) quel que soit le format."""
    root = ET.parse(path).getroot()
    name = None
    pts = []

    if local(root.tag) == "gpx":
        for el in root.iter():
            t = local(el.tag)
            if t == "trkpt" or t == "rtept":
                pts.append((float(el.get("lon")), float(el.get("lat"))))
        # nom : celui de la trace/route, sinon celui des métadonnées
        for el in root.iter():
            if local(el.tag) in ("trk", "rte"):
                n = next((c.text for c in el if local(c.tag) == "name"), None)
                if n:
                    name = n
                    break
        if name is None:
            name = next((el.text for el in root.iter() if local(el.tag) == "name"), None)
        if not pts:
            sys.exit("GPX sans <trkpt> ni <rtept>")

    elif local(root.tag) == "kml":
        name = next((el.text for el in root.iter() if local(el.tag) == "name"), None)
        # gx:Track : <gx:coord>lon lat alt</gx:coord>
        for el in root.iter():
            if local(el.tag) == "coord":
                lon, lat = el.text.split()[:2]
                pts.append((float(lon), float(lat)))
        # LineString : <coordinates>lon,lat,alt lon,lat,alt …</coordinates>
        if not pts:
            for el in root.iter():
                if local(el.tag) == "coordinates":
                    for tok in re.split(r"\s+", el.text.strip()):
                        if tok:
                            lon, lat = tok.split(",")[:2]
                            pts.append((float(lon), float(lat)))
        if not pts:
            sys.exit("KML sans <coordinates> ni <gx:coord>")
    else:
        sys.exit(f"Format non reconnu : racine <{local(root.tag)}>")

    pts = [(round(lon, 6), round(lat, 6)) for lon, lat in pts]
    # supprime les doublons consécutifs stricts (fréquents dans les KML)
    dedup = [pts[0]]
    for p in pts[1:]:
        if p != dedup[-1]:
            dedup.append(p)
    return name or os.path.basename(path), dedup


def haversine(a, b):
    R = 6371008.8
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def main():
    src = find_input()
    name, pts = parse(src)

    cum = [0.0]
    for i in range(len(pts) - 1):
        cum.append(cum[-1] + haversine(pts[i], pts[i + 1]))
    total = cum[-1]

    # ── Vérifications de cohérence ──
    for i in range(1, len(cum)):
        assert cum[i] > cum[i - 1], f"Point {i} : distance cumulée non croissante"
    gaps = [(i, cum[i + 1] - cum[i]) for i in range(len(pts) - 1) if cum[i + 1] - cum[i] > 150]
    if gaps:
        print(f"ATTENTION : {len(gaps)} segment(s) > 150 m (trous ?) :", ", ".join(f"km {cum[i]/1000:.2f} ({g:.0f} m)" for i, g in gaps[:10]))
    if not 40_000 < total < 46_000:
        print(f"ATTENTION : longueur {total/1000:.2f} km, inhabituelle pour un marathon")

    def point_at(dist_m):
        i = min(bisect.bisect_right(cum, dist_m) - 1, len(pts) - 2)
        t = (dist_m - cum[i]) / (cum[i + 1] - cum[i])
        return [round(pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, 6),
                round(pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, 6)]

    parcours = {
        "type": "Feature",
        "properties": {
            "name": name,
            "source": os.path.basename(src),
            "length_m": round(total),
            "n_points": len(pts),
        },
        "geometry": {"type": "LineString", "coordinates": [list(p) for p in pts]},
    }

    km_features = []
    k = 1
    while k * 1000 < total:
        km_features.append({"type": "Feature",
                            "properties": {"km": k, "label": str(k)},
                            "geometry": {"type": "Point", "coordinates": point_at(k * 1000)}})
        k += 1

    out = os.path.join(ROOT, "src", "data")
    with open(os.path.join(out, "parcours.json"), "w", encoding="utf-8") as f:
        json.dump(parcours, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(out, "km.json"), "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": km_features}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"OK — {os.path.basename(src)} : {len(pts)} points, {total/1000:.3f} km, {len(km_features)} bornes km")
    print("Pensez à vérifier les kmHint dans src/data/lieux.ts si le tracé a changé (avertissements dans la console navigateur).")


if __name__ == "__main__":
    main()
