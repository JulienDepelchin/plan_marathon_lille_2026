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
import { mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync, renameSync } from "node:fs";
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

// --chunk N : rendu par morceaux de N images d'animation, reprenable (relancer la même commande
// reprend au premier morceau manquant), puis assemblage automatique et timecodes recalculés.
const CHUNK = args.chunk != null ? Number(args.chunk) : 0;
const PREROLL = 240; // images jouées sans capture avant un morceau, pour que la caméra soit stabilisée

function encoder(out) {
  const ff = spawn(
    ffmpegPath(),
    ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
     "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    { stdio: ["pipe", "inherit", "inherit"] }
  );
  const write = (buf) => new Promise((res, rej) => { ff.stdin.write(buf, (e) => (e ? rej(e) : res())); });
  const close = () => { ff.stdin.end(); return new Promise((res) => ff.on("close", res)); };
  return { write, close };
}

/** Rend les images d'animation [startF, endF[ dans `out`. Repères en images locales au fichier. */
async function renderRange(page, startF, endF, frames, isFirst, isLast, out) {
  const { write, close } = encoder(out);
  const shot = () => page.screenshot({ type: "png", animations: "disabled" });
  await page.evaluate(() => window.__mf.start());
  let { d } = await page.evaluate(() => window.__mf.step(0));
  if (startF > 0) {
    // saut direct puis pré-roulage : l'état de la caméra est le même qu'en rendu continu
    const pre = Math.min(startF, PREROLL);
    const jump = (startF - pre) / FPS;
    if (jump > 0) ({ d } = await page.evaluate((dt) => window.__mf.step(dt), jump));
    for (let i = 0; i < pre; i++) ({ d } = await page.evaluate((dt) => window.__mf.step(dt), 1 / FPS));
  } else await page.waitForTimeout(500);

  let outFrame = 0;
  const reperes = [];
  if (isFirst) {
    const first = await shot();
    for (let i = 0; i < Math.round(INTRO * FPS); i++, outFrame++) await write(first);
  }
  let next = PAUSES.findIndex((p) => p.km * 1000 > d);
  if (next < 0) next = PAUSES.length;
  if (startF === 0) next = 0;
  const t0 = Date.now();
  let done = false;
  for (let i = startF; i < endF && !done; i++) {
    ({ done, d } = await page.evaluate((dt) => window.__mf.step(dt), 1 / FPS));
    const img = await shot();
    await write(img);
    outFrame++;
    while (next < PAUSES.length && d >= PAUSES[next].km * 1000) {
      const p = PAUSES[next++];
      reperes.push({ nom: p.nom, km: p.km, debut: outFrame, fin: outFrame + Math.round(HOLD * FPS) });
      for (let k = 0; k < Math.round(HOLD * FPS); k++, outFrame++) await write(img);
    }
    if (TO_KM != null && d >= TO_KM * 1000) { done = true; break; }
    if ((i - startF) % FPS === 0) {
      const el = (Date.now() - t0) / 1000;
      const eta = (el / (i - startF + 1)) * (endF - i - 1);
      process.stdout.write(`  image ${i + 1}/${frames}  (${el.toFixed(0)} s écoulées, ~${eta.toFixed(0)} s restantes pour ce morceau)   `);
    }
  }
  process.stdout.write(String.fromCharCode(10));
  if (isLast || done) {
    const last = await shot();
    for (let i = 0; i < Math.round(OUTRO * FPS); i++, outFrame++) await write(last);
  }
  await close();
  return { outFrames: outFrame, reperes, done };
}

function writeReperes(reperes) {
  if (!reperes.length) return;
  const csv = OUT.replace(/\.mp4$/i, "") + "-reperes.csv";
  const NL = String.fromCharCode(10);
  const BOM = String.fromCharCode(0xfeff); // Excel lit l'UTF-8 correctement
  const rowsCsv = reperes.map((r) => `${r.nom};${String(r.km).replace(".", ",")};${timecode(r.debut)};${timecode(r.fin)}`);
  writeFileSync(csv, BOM + ["repere;km;debut_arret;fin_arret", ...rowsCsv].join(NL) + NL, "utf-8");
  console.log(`Repères (${FPS} i/s) → ${csv}`);
  for (const r of reperes) console.log(`  ${timecode(r.debut)}  ${r.nom} (km ${r.km})`);
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
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

  if (!CHUNK) {
    const r = await renderRange(page, 0, frames, frames, true, true, OUT);
    writeReperes(r.reperes);
  } else {
    const dir = OUT.replace(/\.mp4$/i, "") + "_morceaux";
    mkdirSync(dir, { recursive: true });
    const n = Math.ceil(frames / CHUNK);
    const parts = [];
    for (let k = 0; k < n; k++) {
      const file = resolve(dir, `morceau_${String(k).padStart(2, "0")}.mp4`);
      const meta = file.replace(/\.mp4$/, ".json");
      parts.push({ file, meta });
      if (existsSync(file) && existsSync(meta)) { console.log(`morceau ${k + 1}/${n} déjà rendu`); continue; }
      const a = k * CHUNK, b = Math.min(frames, (k + 1) * CHUNK);
      console.log(`morceau ${k + 1}/${n} : images ${a}-${b - 1}`);
      const tmp = file.replace(/\.mp4$/, ".tmp.mp4");
      const r = await renderRange(page, a, b, frames, k === 0, k === n - 1, tmp);
      renameSync(tmp, file);
      writeFileSync(meta, JSON.stringify({ outFrames: r.outFrames, reperes: r.reperes }));
      console.log(`morceau ${k + 1}/${n} terminé`);
    }
    // assemblage + timecodes globaux
    const list = resolve(dir, "liste.txt");
    writeFileSync(list, parts.map((p) => `file '${p.file.split(String.fromCharCode(92)).join("/")}'`).join(String.fromCharCode(10)));
    await new Promise((res, rej) => {
      const c = spawn(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", OUT], { stdio: "inherit" });
      c.on("close", (code) => (code === 0 ? res() : rej(new Error("assemblage ffmpeg : code " + code))));
    });
    let offset = 0;
    const all = [];
    for (const p of parts) {
      const m = JSON.parse(readFileSync(p.meta, "utf-8"));
      for (const r of m.reperes) all.push({ ...r, debut: r.debut + offset, fin: r.fin + offset });
      offset += m.outFrames;
    }
    writeReperes(all);
  }
  await browser.close();
  console.log(`OK → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
