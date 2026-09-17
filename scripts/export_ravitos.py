"""
Exporte départ, ravitaillements (tous les 5 km) et arrivée en GeoJSON, CSV et GPX (waypoints),
pour un éditeur de carte externe (Maps4News, QGIS, Illustrator via QGIS…).

Usage :  python scripts/export_ravitos.py [--km 5,10,15,20,25,30,35,40]
Sorties : exports/ravitos.geojson, exports/ravitos.csv, exports/ravitos.gpx

Les positions sont interpolées le long du tracé courant (src/data/parcours.json), donc sur NOTRE
mesure du parcours (42,19 km) : à recaler si l'organisateur communique ses emplacements exacts.
"""
import bisect
import csv
import json
import math
import os
import sys
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "exports")
os.makedirs(OUT, exist_ok=True)

kms = [5, 10, 15, 20, 25, 30, 35, 40]
if len(sys.argv) > 2 and sys.argv[1] == "--km":
    kms = [float(k) for k in sys.argv[2].split(",")]

with open(os.path.join(ROOT, "src", "data", "parcours.json"), encoding="utf-8") as f:
    pts = json.load(f)["geometry"]["coordinates"]


def haversine(a, b):
    R = 6371008.8
    lon1, lat1, lon2, lat2 = map(math.radians, (*a[:2], *b[:2]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


cum = [0.0]
for i in range(len(pts) - 1):
    cum.append(cum[-1] + haversine(pts[i], pts[i + 1]))
total = cum[-1]


def point_at(d):
    d = max(0.0, min(d, total))
    i = min(bisect.bisect_right(cum, d) - 1, len(pts) - 2)
    t = (d - cum[i]) / (cum[i + 1] - cum[i]) if cum[i + 1] > cum[i] else 0
    return (round(pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, 6),
            round(pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, 6))


rows = [{"id": "depart", "type": "depart", "nom": "Départ", "km": 0.0, "coord": point_at(0)}]
for k in kms:
    rows.append({"id": f"ravito-{k:g}", "type": "ravito", "nom": f"Ravitaillement km {k:g}", "km": float(k), "coord": point_at(k * 1000)})
rows.append({"id": "arrivee", "type": "arrivee", "nom": "Arrivée", "km": round(total / 1000, 3), "coord": point_at(total)})

# GeoJSON
fc = {"type": "FeatureCollection", "features": [
    {"type": "Feature",
     "properties": {"id": r["id"], "type": r["type"], "nom": r["nom"], "km": r["km"]},
     "geometry": {"type": "Point", "coordinates": [r["coord"][0], r["coord"][1]]}}
    for r in rows]}
with open(os.path.join(OUT, "ravitos.geojson"), "w", encoding="utf-8") as f:
    json.dump(fc, f, ensure_ascii=False, indent=1)

# CSV (UTF-8 avec BOM pour Excel, séparateur point-virgule, décimales avec point pour les SIG)
with open(os.path.join(OUT, "ravitos.csv"), "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f, delimiter=";")
    w.writerow(["id", "type", "nom", "km", "latitude", "longitude"])
    for r in rows:
        w.writerow([r["id"], r["type"], r["nom"], f"{r['km']:g}", f"{r['coord'][1]:.6f}", f"{r['coord'][0]:.6f}"])

# GPX (waypoints)
gpx = ['<?xml version="1.0" encoding="UTF-8"?>',
       '<gpx version="1.1" creator="La Voix du Nord - marathon de Lille 2026" xmlns="http://www.topografix.com/GPX/1/1">']
for r in rows:
    gpx.append(f'  <wpt lat="{r["coord"][1]:.6f}" lon="{r["coord"][0]:.6f}"><name>{escape(r["nom"])}</name>'
               f'<desc>km {r["km"]:g}</desc><type>{r["type"]}</type></wpt>')
gpx.append("</gpx>")
with open(os.path.join(OUT, "ravitos.gpx"), "w", encoding="utf-8") as f:
    f.write("\n".join(gpx) + "\n")

# Le tracé lui-même, au même endroit, pour l'importer avec les points
with open(os.path.join(ROOT, "src", "data", "parcours.json"), encoding="utf-8") as src, \
        open(os.path.join(OUT, "parcours.geojson"), "w", encoding="utf-8") as dst:
    dst.write(src.read())

print(f"{len(rows)} points -> exports/ravitos.geojson, .csv, .gpx + exports/parcours.geojson  (tracé {total/1000:.3f} km)")
for r in rows:
    print(f"  {r['nom']:22s} km {r['km']:6.2f}  {r['coord'][1]:.6f}, {r['coord'][0]:.6f}")
