/**
 * Export vidéo du survol, image par image, via un Chromium piloté (Playwright) + ffmpeg.
 *
 * Prérequis : `npm run dev` lancé (http://localhost:5173), token Mapbox dans .env,
 *             `npx playwright install chromium` fait une fois.
 *
 * Usage :
 *   node scripts/export-video.mjs [--out sorties/survol.mp4] [--width 1080] [--height 1920]
 *                                 [--fps 30] [--rate 6] [--duration 60] [--engine mapbox|maplibre]
 *                                 [--intro 1.5] [--outro 2] [--headless]
 *
 *   --rate      multiplicateur de vitesse du survol (2 = comme le site ; 4 recommandé pour la vidéo)
 *   --altitude --pitch --lookahead --smoothing --slowdown --lift : caméra du préréglage vidéo
 *               (défauts : 700 m, 60°, 120 m, 350 m, 0.65, 0.6 — plus haut, plus calme et plus lent
 *               que le site dans les zones tortueuses ; voir props du composant)
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
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
const URL = `http://localhost:5173/?export=1&engine=${ENGINE}${CAM}`;

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

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=default", `--window-size=${WIDTH},${HEIGHT + 120}`],
  });
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
  for (let i = 0; i < Math.round(INTRO * FPS); i++) await write(first);

  const t0 = Date.now();
  let done = false;
  for (let i = 0; i < frames && !done; i++) {
    ({ done } = await page.evaluate((dt) => window.__mf.step(dt), 1 / FPS));
    await write(await shot());
    if (i % FPS === 0) {
      const el = (Date.now() - t0) / 1000;
      const eta = (el / (i + 1)) * (frames - i - 1);
      process.stdout.write(`\r  image ${i + 1}/${frames}  (${el.toFixed(0)} s écoulées, ~${eta.toFixed(0)} s restantes)   `);
    }
  }
  process.stdout.write("\n");

  // outro figée
  const last = await shot();
  for (let i = 0; i < Math.round(OUTRO * FPS); i++) await write(last);

  ff.stdin.end();
  await new Promise((res) => ff.on("close", res));
  await browser.close();
  console.log(`OK → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
