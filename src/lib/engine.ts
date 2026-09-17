/**
 * Moteur de carte interchangeable : Mapbox GL JS (défaut) ou MapLibre GL JS.
 *
 * Pourquoi : Mapbox facture au-delà de 50 000 chargements/mois. MapLibre + tuiles
 * OpenFreeMap (vecteur, gratuit, sans clé, usage commercial autorisé) + orthophoto IGN
 * (Géoplateforme, sans clé, licence ouverte) constituent une sortie de secours sans
 * réécrire le composant : on change `engine="maplibre"` et c'est tout.
 *
 * Les deux bibliothèques partagent l'essentiel de leur API (addSource/addLayer, Marker,
 * fitBounds…). Ce module isole les différences : chargement, styles, caméra, polices,
 * propriétés de peinture propres à Mapbox, source des bâtiments 3D.
 *
 * Chargement dynamique : seule la bibliothèque choisie est téléchargée, et jamais côté
 * serveur (les deux touchent `window` à l'import).
 */
import type mapboxgl from "mapbox-gl";

export type Engine = "mapbox" | "maplibre";
export type Basemap = "standard" | "standard-satellite" | "satellite" | "light" | "dark";

/** Type nominal partagé : l'API de MapLibre est structurellement compatible sur le sous-ensemble utilisé. */
export type GLMap = mapboxgl.Map;
export type GLMarker = mapboxgl.Marker;

export interface CreateMapOptions {
  container: HTMLElement;
  style: string | object;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  cooperativeGestures: boolean;
  accessToken?: string | undefined;
}

export interface BuildingsSource {
  source: string;
  sourceLayer: string;
  height: unknown; // expression
  base: unknown; // expression
  /** calques 3D natifs du style à masquer pour éviter le doublon */
  hideLayers: string[];
}

export interface GL {
  engine: Engine;
  createMap(o: CreateMapOptions): GLMap;
  marker(element: HTMLElement, anchor: "bottom" | "center"): GLMarker;
  navigationControl(): mapboxgl.IControl;
  /** Place la caméra à `altitude` m au-dessus de `from`, regardant `to` au sol. */
  lookFromTo(map: GLMap, from: [number, number], altitude: number, to: [number, number]): void;
  styleFor(b: Basemap): string | object;
  /** Le style Mapbox Standard (config, slots) ? */
  isStandard(b: Basemap): boolean;
  /** Fond photo (vue à plat) ? */
  isSatellite(b: Basemap): boolean;
  /** Pile de polices pour les étiquettes */
  fontStack: string[];
  /** `*-emissive-strength` (Mapbox v3 uniquement) */
  supportsEmissive: boolean;
  supportsFog: boolean;
  buildings(map: GLMap, b: Basemap): BuildingsSource | null;
  attribution?: string;
}

const MAPBOX_STYLES: Record<Basemap, string> = {
  standard: "mapbox://styles/mapbox/standard",
  "standard-satellite": "mapbox://styles/mapbox/standard-satellite",
  satellite: "mapbox://styles/mapbox/satellite-streets-v12",
  light: "mapbox://styles/mapbox/light-v11",
  dark: "mapbox://styles/mapbox/dark-v11",
};

const OFM = "https://tiles.openfreemap.org";
const IGN_ORTHO =
  "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS" +
  "&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg";

/** Style MapLibre « satellite » : orthophoto IGN seule (pas de rues ni de noms). */
const IGN_SATELLITE_STYLE = {
  version: 8,
  name: "Orthophoto IGN",
  glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
  sources: {
    ign: {
      type: "raster",
      tiles: [IGN_ORTHO],
      tileSize: 256,
      maxzoom: 19,
      attribution: '<a href="https://www.ign.fr/" target="_blank">© IGN</a> – Géoplateforme',
    },
  },
  layers: [{ id: "ign-ortho", type: "raster", source: "ign" }],
};

const MAPLIBRE_STYLES: Record<Basemap, string | object> = {
  standard: `${OFM}/styles/liberty`, // le seul style OFM avec un calque 3D natif (building-3d)
  "standard-satellite": IGN_SATELLITE_STYLE,
  satellite: IGN_SATELLITE_STYLE,
  light: `${OFM}/styles/positron`,
  dark: `${OFM}/styles/dark`,
};

const FR_LOCALE_MAPBOX = {
  "ScrollZoomBlocker.CtrlMessage": "Ctrl + molette pour zoomer la carte",
  "ScrollZoomBlocker.CmdMessage": "⌘ + molette pour zoomer la carte",
  "TouchPanBlocker.Message": "Deux doigts pour déplacer la carte",
  "NavigationControl.ZoomIn": "Zoom avant",
  "NavigationControl.ZoomOut": "Zoom arrière",
  "NavigationControl.ResetBearing": "Remettre le nord en haut",
};
const FR_LOCALE_MAPLIBRE = {
  "CooperativeGesturesHandler.WindowsHelpText": "Ctrl + molette pour zoomer la carte",
  "CooperativeGesturesHandler.MacHelpText": "⌘ + molette pour zoomer la carte",
  "CooperativeGesturesHandler.MobileHelpText": "Deux doigts pour déplacer la carte",
  "NavigationControl.ZoomIn": "Zoom avant",
  "NavigationControl.ZoomOut": "Zoom arrière",
  "NavigationControl.ResetBearing": "Remettre le nord en haut",
};

export async function loadEngine(engine: Engine): Promise<GL> {
  if (engine === "maplibre") {
    const [ml] = await Promise.all([import("maplibre-gl"), import("maplibre-gl/dist/maplibre-gl.css")]);
    // MapLibre exporte ses classes en nommé (Map, Marker, LngLat…) ; on les manipule en `any`
    // pour partager les types nominaux de mapbox-gl dans le reste du composant.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lib = ml as any;
    return {
      engine,
      createMap: (o) =>
        new lib.Map({
          container: o.container,
          style: o.style,
          center: o.center,
          zoom: o.zoom,
          pitch: o.pitch,
          bearing: o.bearing,
          maxPitch: 85, // MapLibre plafonne à 60° par défaut ; le survol est à 70°
          antialias: true,
          cooperativeGestures: o.cooperativeGestures,
          locale: FR_LOCALE_MAPLIBRE,
        }) as GLMap,
      marker: (element, anchor) => new lib.Marker({ element, anchor }) as GLMarker,
      navigationControl: () => new lib.NavigationControl({ visualizePitch: true }) as mapboxgl.IControl,
      lookFromTo: (map, from, altitude, to) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m = map as any;
        const opts = m.calculateCameraOptionsFromTo(new lib.LngLat(from[0], from[1]), altitude, new lib.LngLat(to[0], to[1]), 0);
        m.jumpTo(opts);
      },
      styleFor: (b) => MAPLIBRE_STYLES[b],
      isStandard: () => false,
      isSatellite: (b) => b.includes("satellite"),
      fontStack: ["Noto Sans Bold"],
      supportsEmissive: false,
      supportsFog: false,
      buildings: (map, b) => {
        if (b.includes("satellite") || !map.getSource("openmaptiles")) return null;
        return {
          source: "openmaptiles",
          sourceLayer: "building",
          height: ["coalesce", ["get", "render_height"], 6],
          base: ["coalesce", ["get", "render_min_height"], 0],
          hideLayers: ["building-3d"], // liberty : on remplace son calque 3D par le nôtre (couleurs VDN)
        };
      },
    };
  }

  const [{ default: mb }] = await Promise.all([import("mapbox-gl"), import("mapbox-gl/dist/mapbox-gl.css")]);
  return {
    engine,
    createMap: (o) => {
      if (o.accessToken) mb.accessToken = o.accessToken;
      return new mb.Map({
        container: o.container,
        style: o.style as string,
        center: o.center,
        zoom: o.zoom,
        pitch: o.pitch,
        bearing: o.bearing,
        antialias: true,
        attributionControl: true,
        cooperativeGestures: o.cooperativeGestures,
        locale: FR_LOCALE_MAPBOX,
      });
    },
    marker: (element, anchor) => new mb.Marker({ element, anchor }),
    navigationControl: () => new mb.NavigationControl({ visualizePitch: true }),
    lookFromTo: (map, from, altitude, to) => {
      const cam = map.getFreeCameraOptions();
      cam.position = mb.MercatorCoordinate.fromLngLat(from, altitude);
      cam.lookAtPoint(to);
      map.setFreeCameraOptions(cam);
    },
    styleFor: (b) => MAPBOX_STYLES[b],
    isStandard: (b) => b.startsWith("standard"),
    isSatellite: (b) => b.includes("satellite"),
    fontStack: ["DIN Pro Bold", "Arial Unicode MS Bold"],
    supportsEmissive: true,
    supportsFog: true,
    buildings: (map, b) => {
      // styles classiques uniquement (Standard gère ses propres bâtiments 3D)
      if (b.startsWith("standard") || !map.getSource("composite")) return null;
      return {
        source: "composite",
        sourceLayer: "building",
        height: ["get", "height"],
        base: ["get", "min_height"],
        hideLayers: [],
      };
    },
  };
}
