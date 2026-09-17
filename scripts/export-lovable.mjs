/**
 * Copie les fichiers de production vers un clone du dépôt Lovable.
 *
 * Usage :  npm run export -- <chemin/du/clone/lovable>
 *
 * Copie : src/components/MarathonFlyover.tsx, src/lib/path.ts, src/data/{parcours.json,km.json,lieux.ts}
 * Ne touche ni à la page (src/routes/index.tsx) ni au token : ils vivent côté Lovable.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!target) {
  console.error("Usage : npm run export -- <chemin du clone Lovable>");
  process.exit(1);
}
if (!existsSync(join(target, "package.json"))) {
  console.error(`Pas de package.json dans ${target} : est-ce bien le clone Lovable ?`);
  process.exit(1);
}

const FILES = [
  "src/components/MarathonFlyover.tsx",
  "src/lib/path.ts",
  "src/lib/engine.ts",
  "src/lib/camera.ts",
  "src/data/parcours.json",
  "src/data/km.json",
  "src/data/lieux.ts",
];

for (const f of FILES) {
  const dest = join(target, f);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(root, f), dest);
  console.log("→", f);
}
console.log(`\n${FILES.length} fichiers copiés vers ${resolve(target)}. Reste à faire là-bas : git add/commit/push.`);
