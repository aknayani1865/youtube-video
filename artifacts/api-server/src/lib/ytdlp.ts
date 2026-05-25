import fs from "node:fs";
import path from "node:path";

const localBinary = path.resolve(process.cwd(), "..", "..", "tools", "yt-dlp.exe");
const localAria2 = path.resolve(process.cwd(), "..", "..", "tools", "aria2-1.37.0-win-64bit-build1", "aria2c.exe");
const localFfmpegDir = path.resolve(process.cwd(), "..", "..", "tools", "ffmpeg-8.1.1-essentials_build", "bin");
const localFfmpeg = path.join(localFfmpegDir, "ffmpeg.exe");

export const ytDlpPath =
  process.env.YTDLP_PATH ?? (fs.existsSync(localBinary) ? localBinary : "yt-dlp");

export const ffmpegPath =
  process.env.FFMPEG_PATH ?? (fs.existsSync(localFfmpeg) ? localFfmpeg : "ffmpeg");

const aria2Path =
  process.env.ARIA2C_PATH ?? (fs.existsSync(localAria2) ? localAria2 : "aria2c");

const ffmpegLocation =
  process.env.FFMPEG_LOCATION ?? (fs.existsSync(localFfmpeg) ? localFfmpegDir : "");

export function ytDlpSetupMessage(): string {
  return (
    "yt-dlp was not found. Install yt-dlp and make sure it is on PATH, " +
    "set YTDLP_PATH to yt-dlp.exe, or place yt-dlp.exe in the project tools folder."
  );
}

export function isMissingYtDlpError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
export function ytDlpAuthArgs(): string[] {
  const cookiesFile = process.env.YTDLP_COOKIES_FILE?.trim();
  if (cookiesFile) return ["--cookies", cookiesFile];

  const cookiesBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (cookiesBrowser) return ["--cookies-from-browser", cookiesBrowser];

  return [];
}

export function ytDlpInfoArgs(): string[] {
  const args: string[] = [];

  if (process.env.YTDLP_INFO_CHECK_FORMATS !== "true") {
    args.push("--no-check-formats");
  }

  args.push(...ytDlpExtractorArgs());

  return args;
}

export function ytDlpDownloadArgs(): string[] {
  const args: string[] = [];
  const useAria2 = process.env.YTDLP_USE_ARIA2 === "true" && (process.env.ARIA2C_PATH || fs.existsSync(localAria2));

  if (ffmpegLocation) {
    args.push("--ffmpeg-location", ffmpegLocation);
  }

  if (useAria2) {
    args.push(
      "--downloader",
      aria2Path,
      "--downloader-args",
      [
        "aria2c:",
        "-x",
        process.env.ARIA2C_MAX_CONNECTIONS ?? "16",
        "-s",
        process.env.ARIA2C_SPLIT ?? "16",
        "-k",
        process.env.ARIA2C_MIN_SPLIT_SIZE ?? "1M",
        "--file-allocation=none",
        "--summary-interval=0",
      ].join(" "),
    );
  } else {
    const httpChunkSize = process.env.YTDLP_HTTP_CHUNK_SIZE?.trim() ?? "10M";

    if (httpChunkSize && httpChunkSize !== "0" && httpChunkSize.toLowerCase() !== "false") {
      args.push("--http-chunk-size", httpChunkSize);
    }
  }

  const throttledRate = process.env.YTDLP_THROTTLED_RATE?.trim();
  if (throttledRate) {
    args.push("--throttled-rate", throttledRate);
  }

  args.push(...ytDlpExtractorArgs());

  return args;
}

function ytDlpProxyArgs(): string[] {
  const proxy = process.env.YTDLP_PROXY?.trim();
  return proxy ? ["--proxy", proxy] : [];
}

function ytDlpExtractorArgs(): string[] {
  const args: string[] = [];

 const extractorArgs =
    process.env.YTDLP_EXTRACTOR_ARGS?.trim() ?? "youtube:player_client=default";
  args.push("--extractor-args", extractorArgs);

  if (process.env.YTDLP_FORCE_IPV4 === "true") {
    args.push("--force-ipv4");
  }

  args.push(...ytDlpProxyArgs());

  return args;
}

export function ytDlpErrorMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : fallback;
  const needsCookies = /sign in to confirm|not a bot|cookies/i.test(message);

  if (needsCookies && ytDlpAuthArgs().length === 0) {
    return (
      "YouTube is asking for a signed-in browser session. Restart the API with " +
      "YTDLP_COOKIES_FROM_BROWSER=chrome, or set YTDLP_COOKIES_FILE to an exported cookies.txt file."
    );
  }

  return message;
}
