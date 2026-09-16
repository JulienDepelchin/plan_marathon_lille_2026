/**
 * Points mis en avant sur la carte : départ, ravitaillements, arrivée.
 * ─ CHOIX ÉDITORIAL : liste à valider par la rédaction.
 *
 * Deux façons de placer un point :
 *  - `km`    : distance le long du tracé (le point est posé exactement sur la route) — pour les ravitos ;
 *  - `coord` : [lon, lat] d'un lieu réel, accroché au passage le plus proche (`kmHint` départage
 *              les rues parcourues deux fois) — pour un monument.
 *
 * `type` pilote le style du marqueur : "depart" | "arrivee" | "ravito" | "lieu".
 */
export type LieuType = "depart" | "arrivee" | "ravito" | "lieu";

export interface Lieu {
  id: string;
  nom: string;
  description?: string;
  type?: LieuType;
  km?: number;
  coord?: [number, number];
  kmHint?: number;
  horsTrace?: number;
}

const RAVITOS_KM = [5, 10, 15, 20, 25, 30, 35, 40];

export const LIEUX: Lieu[] = [
  {
    id: "depart",
    type: "depart",
    nom: "Départ",
    description: "215 boulevard de la Liberté, au pied de la Porte de Paris et du beffroi de l'hôtel de ville.",
    km: 0,
  },
  ...RAVITOS_KM.map<Lieu>((k) => ({
    id: `ravito-${k}`,
    type: "ravito",
    nom: `Ravitaillement km ${k}`,
    km: k,
  })),
  {
    id: "arrivee",
    type: "arrivee",
    nom: "Arrivée",
    description: "Esplanade du Champ de Mars, au pied de la Citadelle Vauban.",
    km: Infinity, // = fin du tracé
  },
];
