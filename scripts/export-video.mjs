/**
 * Export vidéo du survol, image par image, via un Chromium piloté (Playwright) + ffmpeg.
 *
 * Prérequis : `npm run dev` lancé (http://localhost:5173), token Mapbox dans .env,
 *             `npx playwright install chromium` fait une fois.
 *
 * Usage :
 *   node scripts/export-video.mjs [--out sorties/survol.mp4] [--width 1080] [--height 1920]
 *                                 [--fps 30] [--rate 6] [--duration 60] [--engine mapbox|maplibre]
 *                                 [--intro 1.5] [--outro 2] [--headless] [--avatar photo.jpg]
 *                                 [--pauses video/pauses.json] [--hold 3] [--to-km 3.5]
 *
 *   --rate      multiplicateur de vitesse du survol (2 = comme le site ; 4 recommandé pour la vidéo)
 *   --altitude --pitch --lookahead --smoothing --slowdown --lift : caméra du préréglage vidéo
 *               (défauts : 450 m, 70°, 120 m, 350 m, 0.65, 0.4 — même pitch que le site, un peu plus
 *               proche, cap plus lissé, plus lent et plus haut dans les zones tortueuses)
 *   --duration  durée maximale de la vidéo en secondes (0 = jusqu'à l'arrivée)
 *   --intro     secondes figées sur la première image avant le départ
 *   --outro     secondes figées sur l'arrivée
 *
 * Principe : l'animation n'est pas jouée en temps réel. À chaque image, la page avance de 1/fps s
 * (window.__mf.step), attend que Mapbox ait fini de charger et dessiner (événement `idle`),
 * puis Playwright capture la page entière (carte + bulles + coureur + timeline). Les images sont
 * envoyées à ffmpeg par un tube : rien n'est écrit sur disque à part le .mp4 final.
 */
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { chromium } from "playwright";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] == null ? "1" : arr[i + 1]] : null)).filter(Boolean)
);
const OUT = resolve(args.out ?? "sorties/survol.mp4");
const WIDTH = Number(args.width ?? 1080);
const HEIGHT = Number(args.height ?? 1920);
const FPS = Number(args.fps ?? 30);
const RATE = Number(args.rate ?? 6);
const DURATION = Number(args.duration ?? 0);
const ENGINE = args.engine ?? "mapbox";
const INTRO = Number(args.intro ?? 1.5);
const OUTRO = Number(args.outro ?? 2);
const HEADLESS = args.headless === "1";
// réglages caméra du préréglage vidéo (défauts dans src/App.tsx) : --altitude --pitch --lookahead --smoothing --slowdown --lift
const CAM = ["altitude", "pitch", "lookahead", "smoothing", "slowdown", "lift"]
  .filter((k) => args[k] != null)
  .map((k) => `&${k}=${encodeURIComponent(args[k])}`)
  .join("");
// --avatar chemin/photo.jpg : la photo remplace le picto coureur (copiée dans public/, ignorée par git)
let AVATAR = "";
if (args.avatar) {
  const src = resolve(args.avatar);
  if (!existsSync(src)) {
    console.error(`Photo introuvable : ${src}`);
    process.exit(1);
  }
  const name = `_avatar${extname(src).toLowerCase() || ".jpg"}`;
  mkdirSync(resolve("public"), { recursive: true });
  copyFileSync(src, resolve("public", name));
  AVATAR = `&avatar=/${name}`;
}
// --pauses fichier.json : repères de séquences tournées [{ "km": 2.8, "nom": "Grand-Place" }, …]
//   la caméra ralentit à l'approche, s'arrête --hold secondes sur le repère (bulle + fiche affichées),
//   et un fichier <sortie>-reperes.csv donne le timecode de chaque arrêt pour caler les rushes au montage
const HOLD = Number(args.hold ?? 3);
const TO_KM = args["to-km"] != null ? Number(args["to-km"]) : null; // coupe la vidéo à ce km (extrait)
let PAUSES = [];
if (args.pauses) {
  PAUSES = JSON.parse(readFileSync(resolve(args.pauses), "utf-8"))
    .filter((p) => typeof p.km === "number")
    .sort((a, b) => a.km - b.km);
}
const PAUSES_Q = PAUSES.length ? `&pauses=${encodeURIComponent(JSON.stringify(PAUSES.map(({ km, nom, affiche }) => ({ km, nom, affiche }))))}` : "";
const URL = `http://localhost:5173/?export=1&engine=${ENGINE}${CAM}${AVATAR}${PAUSES_Q}`;

function timecode(frame) {
  const f = frame % FPS, s = Math.floor(frame / FPS);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}:${p2(f)}`;
}

function ffmpegPath() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  // binaire embarqué par imageio-ffmpeg (Miniconda), présent sur la machine de la rédaction
  const guess = resolve(process.env.LOCALAPPDATA ?? "", "miniconda3/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe");
  if (existsSync(guess)) return guess;
  return "ffmpeg";
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  const ff = spawn(
    ffmpegPath(),
    ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
     "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT],
    { stdio: ["pipe", "inherit", "inherit"] }
  );
  const write = (buf) => new Promise((res, rej) => { ff.stdin.write(buf, (e) => (e ? rej(e) : res())); });

  const launchOpts = {
    headless: HEADLESS,
    args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=default", `--window-size=${WIDTH},${HEIGHT + 120}`],
  };
  // Chromium de Playwright s'il est présent, sinon Microsoft Edge (installé sur tous les postes Windows)
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch {
    console.log("Chromium Playwright absent → Microsoft Edge");
    browser = await chromium.launch({ ...launchOpts, channel: "msedge" });
  }
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("[page]", e.message));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__mf?.isReady(), null, { timeout: 60_000 });

  const total = await page.evaluate(() => window.__mf.total());
  await page.evaluate((r) => window.__mf.setRate(r), RATE);
  const videoSeconds = DURATION > 0 ? Math.min(DURATION, total / RATE) : total / RATE;
  const frames = Math.round(videoSeconds * FPS);
  console.log(`Survol ${(total / 60).toFixed(1)} min à ×1 → vidéo ${videoSeconds.toFixed(0)} s à ×${RATE}, ${frames} images ${WIDTH}×${HEIGHT} @ ${FPS} fps`);

  await page.evaluate(() => window.__mf.start());
  await page.evaluate(() => window.__mf.step(0)); // première image, tuiles chargées
  await page.waitForTimeout(500);

  const shot = () => page.screenshot({ type: "png", animations: "disabled" });

  // intro figée
  const first = await shot();
  let outFrame = 0;
  for (let i = 0; i < Math.round(INTRO * FPS); i++, outFrame++) await write(first);

  const t0 = Date.now();
  let done = false;
  let next = 0; // prochain repère
  const reperes = [];
  for (let i = 0; i < frames && !done; i++) {
    let d;
    ({ done, d } = await page.evaluate((dt) => window.__mf.step(dt), 1 / FPS));
    const img = await shot();
    await write(img);
    outFrame++;
    // arrêt sur repère : l'image courante est tenue HOLD secondes
    while (next < PAUSES.length && d >= PAUSES[next].km * 1000) {
      const p = PAUSES[next++];
      reperes.push({ nom: p.nom, km: p.km, debut: timecode(outFrame), fin: timecode(outFrame + Math.round(HOLD * FPS)) });
      for (let k = 0; k < Math.round(HOLD * FPS); k++, outFrame++) await write(img);
    }
    if (TO_KM != null && d >= TO_KM * 1000) break;
    if (i % FPS === 0) {
      const el = (Date.now() - t0) / 1000;
      const eta = (el / (i + 1)) * (frames - i - 1);
      process.stdout.write(`\r  image ${i + 1}/${frames}  (${el.toFixed(0)} s écoulées, ~${eta.toFixed(0)} s restantes)   `);
    }
  }
  process.stdout.write("\n");

  // outro figée
  const last = await shot();
  for (let i = 0; i < Math.round(OUTRO * FPS); i++, outFrame++) await write(last);

  if (reperes.length) {
    const csv = OUT.replace(/\.mp4$/i, "") + "-reperes.csv";
    const NL = String.fromCharCode(10);
    const BOM = String.fromCharCode(0xfeff); // Excel lit l'UTF-8 correctement
    const rowsCsv = reperes.map((r) => `${r.nom};${String(r.km).replace(".", ",")};${r.debut};${r.fin}`);
    writeFileSync(csv, BOM + ["repere;km;debut_arret;fin_arret", ...rowsCsv].join(NL) + NL, "utf-8");
    console.log(`Repères (${FPS} i/s) → ${csv}`);
    for (const r of reperes) console.log(`  ${r.debut}  ${r.nom} (km ${r.km})`);
  }

  ff.stdin.end();
  await new Promise((res) => ff.on("close", res));
  await browser.close();
  console.log(`OK → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
