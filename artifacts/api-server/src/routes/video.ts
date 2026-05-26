import { Router } from "express";
import { execFile, spawn } from "child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "util";
import { createVideoDownloadToken, consumeVideoDownloadToken } from "../lib/downloadTokens";
import { ffmpegPath, isMissingYtDlpError, ytDlpAuthArgs, ytDlpDownloadArgs, ytDlpErrorMessage, ytDlpInfoArgs, ytDlpPath, ytDlpSetupMessage } from "../lib/ytdlp";

const execFileAsync = promisify(execFile);
const router = Router();
const YTDLP_MAX_BUFFER = 50 * 1024 * 1024;
const VIDEO_INFO_CACHE_TTL_MS = 30 * 60 * 1000;
const VIDEO_INFO_DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const VIDEO_INFO_CACHE_DIR = process.env.VIDEO_INFO_CACHE_DIR ?? path.join(process.cwd(), ".cache", "video-info");

interface YtDlpFormat {
  format_id: string;
  ext: string;
  url?: string;
  width?: number | null;
  height?: number | null;
  acodec?: string;
  vcodec?: string;
  filesize?: number | null;
  filesize_approx?: number | null;
  format_note?: string;
  quality?: number;
  tbr?: number;
  abr?: number;
  vbr?: number;
}

interface YtDlpInfo {
  id: string;
  title: string;
  uploader?: string;
  thumbnail: string;
  thumbnails?: { url: string; width?: number; height?: number }[];
  duration?: number;
  view_count?: number | null;
  formats: YtDlpFormat[];
}

interface YoutubeiFormat {
  itag?: number;
  url?: string;
  mimeType?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  contentLength?: string;
  qualityLabel?: string;
  quality?: string;
  audioQuality?: string;
  averageBitrate?: number;
}

interface YoutubeiPlayerResponse {
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
    viewCount?: string;
    thumbnail?: { thumbnails?: { url: string; width?: number; height?: number }[] };
  };
  streamingData?: {
    formats?: YoutubeiFormat[];
    adaptiveFormats?: YoutubeiFormat[];
  };
}

interface ApiVideoFormat {
  itag: string;
  quality: string;
  qualityLabel: string;
  mimeType: string;
  hasAudio: boolean;
  hasVideo: boolean;
  container: string;
  filesize: number | null;
}

interface ApiVideoInfo {
  videoId: string;
  title: string;
  author: string;
  thumbnailUrl: string;
  durationSeconds: number;
  viewCount: number | null;
  formats: ApiVideoFormat[];
}

interface InternalVideoFormat extends ApiVideoFormat {
  directUrl?: string;
}

interface InternalVideoInfo extends Omit<ApiVideoInfo, "formats"> {
  formats: InternalVideoFormat[];
}

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type PrepareTask = {
  id: string;
  title: string;
  tempDir: string;
  outputPath: string | null;
  progress: number;
  status: "running" | "success" | "error";
  error: string | null;
  createdAt: number;
};

const videoInfoCache = new Map<string, CacheEntry<InternalVideoInfo>>();
const pendingVideoInfo = new Map<string, Promise<InternalVideoInfo>>();
const prepareTasks = new Map<string, PrepareTask>();

function isProbablyStreamingPlaylistUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /(?:manifest|m3u8|mpd|playlist)/i.test(url);
}

function hasKnownFileSize(format: Pick<InternalVideoFormat, "filesize">): boolean {
  return typeof format.filesize === "number" && Number.isFinite(format.filesize) && format.filesize > 0;
}

function hasPlausibleMediaFileSize(format: InternalVideoFormat, durationSeconds = 0): boolean {
  if (!hasKnownFileSize(format)) return false;
  if (!format.hasVideo || !format.hasAudio) return true;

  const minimumVideoBytes = durationSeconds >= 60 ? 1024 * 1024 : 128 * 1024;
return (format.filesize ?? 0) >= minimumVideoBytes;
}

function isSafeDirectDownloadFormat(
  format: InternalVideoFormat,
): format is InternalVideoFormat & { directUrl: string } {
  return Boolean(format.directUrl) && hasKnownFileSize(format) && !isProbablyStreamingPlaylistUrl(format.directUrl);
}

function hasUsableCachedFormats(info: InternalVideoInfo): boolean {
  return info.formats.some((format) => format.itag.includes("+") || isSafeDirectDownloadFormat(format));
}

function hasSafeFastVideoInfo(info: InternalVideoInfo): boolean {
  const combinedFormats = info.formats.filter((format) => format.hasVideo && format.hasAudio);
  if (combinedFormats.length === 0) return false;

  return combinedFormats.every((format) => {
    if (format.itag.includes("+")) return hasPlausibleMediaFileSize(format, info.durationSeconds);
    return isSafeDirectDownloadFormat(format) && hasPlausibleMediaFileSize(format, info.durationSeconds);
  });
}

function getCachedVideoInfo(url: string): InternalVideoInfo | null {
  const cached = videoInfoCache.get(url);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now() || !hasUsableCachedFormats(cached.value)) {
    videoInfoCache.delete(url);
    return null;
  }
  return cached.value;
}

function setCachedVideoInfo(url: string, value: InternalVideoInfo) {
  videoInfoCache.set(url, {
    value,
    expiresAt: Date.now() + VIDEO_INFO_CACHE_TTL_MS,
  });
}

function videoInfoCachePath(url: string): string {
  const key = crypto.createHash("sha256").update(url).digest("hex");
  return path.join(VIDEO_INFO_CACHE_DIR, `${key}.json`);
}

function isStreamingProtocolUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /[?&](?:manifest|playlist)=|\.m3u8($|[?])|\.mpd($|[?])/i.test(url);
}

function isNativeCombinedFormat(fmt: YtDlpFormat): boolean {
  return hasVideo(fmt) && hasAudio(fmt);
}

function isProgressiveDownloadFormat(fmt: YtDlpFormat): boolean {
  return isNativeCombinedFormat(fmt) && !isStreamingProtocolUrl(fmt.url);
}

function mergedFilesize(video: YtDlpFormat, audio: YtDlpFormat): number | null {
  const videoBytes = formatSize(video);
  const audioBytes = formatSize(audio);
  if (videoBytes && audioBytes) return videoBytes + audioBytes;
  return null;
}
async function getDiskCachedVideoInfo(url: string): Promise<InternalVideoInfo | null> {
  try {
    const raw = await fs.readFile(videoInfoCachePath(url), "utf8");
    const cached = JSON.parse(raw) as CacheEntry<InternalVideoInfo>;
    if (!cached.value || cached.expiresAt <= Date.now() || !hasUsableCachedFormats(cached.value)) return null;
    setCachedVideoInfo(url, cached.value);
    return cached.value;
  } catch {
    return null;
  }
}

async function setDiskCachedVideoInfo(url: string, value: InternalVideoInfo): Promise<void> {
  try {
    await fs.mkdir(VIDEO_INFO_CACHE_DIR, { recursive: true });
    await fs.writeFile(
      videoInfoCachePath(url),
      JSON.stringify({
        value,
        expiresAt: Date.now() + VIDEO_INFO_DISK_CACHE_TTL_MS,
      }),
      "utf8",
    );
  } catch {
    // Disk cache is an optimization; memory cache still works if the filesystem is read-only.
  }
}

function toPublicVideoInfo(info: InternalVideoInfo): ApiVideoInfo {
  return {
    ...info,
    formats: info.formats.map(({ directUrl, ...format }) => format),
  };
}

function parseYoutubeUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;

  const raw = rawUrl.trim();
  const match = raw.match(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/\S+/i);
  let candidate = match?.[0] ?? raw;
  const nestedUrlIndex = candidate.slice(8).search(/https?:\/\//i);
  if (nestedUrlIndex >= 0) {
    candidate = candidate.slice(0, nestedUrlIndex + 8);
  }

  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    const isYoutubeHost = hostname === "youtube.com" || hostname.endsWith(".youtube.com");
    const isShortHost = hostname === "youtu.be";

    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    if (isShortHost) {
      const videoId = url.pathname.split("/").filter(Boolean)[0];
      return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    }

    if (!isYoutubeHost) return null;

    const list = url.searchParams.get("list");
    if (url.pathname === "/playlist" && list) {
      return `https://www.youtube.com/playlist?list=${list}`;
    }

    const directVideoId = url.searchParams.get("v");
    const pathVideoId = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1];
    const videoId = directVideoId ?? pathVideoId;

    if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
    if (list) return `https://www.youtube.com/playlist?list=${list}`;

    return null;
  } catch {
    return null;
  }
}

function videoIdFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("v");
  } catch {
    return null;
  }
}

function hasVideo(fmt: YtDlpFormat): boolean {
  return Boolean(fmt.vcodec && fmt.vcodec !== "none");
}

function hasAudio(fmt: YtDlpFormat): boolean {
  return Boolean(fmt.acodec && fmt.acodec !== "none");
}

function qualityLabel(fmt: YtDlpFormat): string {
  if (fmt.height) return `${fmt.height}p`;
  if (hasAudio(fmt) && !hasVideo(fmt) && fmt.abr) return `${Math.round(fmt.abr)}kbps`;
  if (fmt.format_note) return fmt.format_note;
  if (fmt.abr) return `${Math.round(fmt.abr)}kbps`;
  return fmt.format_id;
}

function formatSize(fmt: YtDlpFormat): number | null {
  return fmt.filesize ?? fmt.filesize_approx ?? null;
}

function parseContentLength(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extFromMimeType(mimeType: string | undefined): string {
  const subtype = mimeType?.split(";")[0]?.split("/")[1]?.trim().toLowerCase();
  if (!subtype) return "mp4";
  if (subtype === "x-m4a") return "m4a";
  return subtype;
}

function codecsFromMimeType(mimeType: string | undefined): string[] {
  const match = mimeType?.match(/codecs="([^"]+)"/i);
  return match?.[1].split(",").map((codec) => codec.trim()) ?? [];
}

function isAudioCodec(codec: string): boolean {
  return /^(mp4a|opus|vorbis|aac)/i.test(codec);
}

function isVideoMimeType(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.startsWith("video/"));
}

function isAudioMimeType(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.startsWith("audio/"));
}

function youtubeiFormatToYtDlpFormat(format: YoutubeiFormat): YtDlpFormat | null {
  if (!format.itag || !format.url || !format.mimeType) return null;

  const codecs = codecsFromMimeType(format.mimeType);
  const audioCodec = codecs.find(isAudioCodec);
  const videoCodec = codecs.find((codec) => !isAudioCodec(codec));
  const audioOnly = isAudioMimeType(format.mimeType);
  const video = isVideoMimeType(format.mimeType);
  const hasAudioTrack = audioOnly || Boolean(audioCodec);
  const hasVideoTrack = video || Boolean(videoCodec);
  const bitrate = format.averageBitrate ?? format.bitrate;

  return {
    format_id: String(format.itag),
    ext: extFromMimeType(format.mimeType),
    width: format.width ?? null,
    height: format.height ?? null,
    acodec: hasAudioTrack ? audioCodec ?? "unknown" : "none",
    vcodec: hasVideoTrack ? videoCodec ?? "unknown" : "none",
    filesize: parseContentLength(format.contentLength),
    filesize_approx: null,
    format_note: format.qualityLabel ?? format.quality,
    tbr: bitrate ? bitrate / 1000 : undefined,
    abr: audioOnly && bitrate ? bitrate / 1000 : undefined,
    vbr: video && bitrate ? bitrate / 1000 : undefined,
    url: format.url,
  };
}

function formatScore(fmt: YtDlpFormat): number {
  return (fmt.height ?? 0) * 10000 + (fmt.tbr ?? fmt.vbr ?? fmt.abr ?? 0);
}

function isMp4Video(fmt: YtDlpFormat): boolean {
  return hasVideo(fmt) && fmt.ext === "mp4" && Boolean(fmt.height);
}

function bestAudioFormat(formats: YtDlpFormat[]): YtDlpFormat | undefined {
  return formats
    .filter((fmt) => hasAudio(fmt) && !hasVideo(fmt))
    .sort((a, b) => {
      const aM4a = a.ext === "m4a" ? 10000 : 0;
      const bM4a = b.ext === "m4a" ? 10000 : 0;
      return bM4a + (b.abr ?? b.tbr ?? 0) - (aM4a + (a.abr ?? a.tbr ?? 0));
    })[0];
}

function makeFormat(fmt: YtDlpFormat): InternalVideoFormat {
  const video = hasVideo(fmt);
  const audio = hasAudio(fmt);

  return {
    itag: fmt.format_id,
    quality: fmt.format_id,
    qualityLabel: qualityLabel(fmt),
    mimeType: video ? `video/${fmt.ext}` : `audio/${fmt.ext === "m4a" ? "mp4" : fmt.ext}`,
    hasAudio: audio,
    hasVideo: video,
    container: fmt.ext,
    filesize: formatSize(fmt),
    directUrl: fmt.url,
  };
}

function makeMergedFormat(video: YtDlpFormat, audio: YtDlpFormat): InternalVideoFormat {
  return {
    itag: `${video.format_id}+${audio.format_id}`,
    quality: video.format_id,
    qualityLabel: qualityLabel(video),
    mimeType: "video/mp4",
    hasAudio: true,
    hasVideo: true,
    container: "mp4",
    filesize: mergedFilesize(video, audio),
  };
}

function uniqueByQuality(formats: InternalVideoFormat[]): InternalVideoFormat[] {
  const seen = new Set<string>();
  return formats.filter((fmt) => {
    const key = `${fmt.qualityLabel}_${fmt.container}_${fmt.hasVideo}_${fmt.hasAudio}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildFormats(info: YtDlpInfo): InternalVideoFormat[] {
  const sourceFormats = info.formats.filter((fmt) => hasVideo(fmt) || hasAudio(fmt));
  const audio = bestAudioFormat(sourceFormats);

  const nativeCombined = sourceFormats
    .filter((fmt) => isProgressiveDownloadFormat(fmt))
    .sort((a, b) => formatScore(b) - formatScore(a))
    .map(makeFormat);

  const nativeCombinedQualities = new Set(nativeCombined.map((fmt) => fmt.qualityLabel));

  const mergedCombined = audio
    ? sourceFormats
        .filter(
          (fmt) =>
            isMp4Video(fmt) &&
            !hasAudio(fmt) &&
            !nativeCombinedQualities.has(qualityLabel(fmt)),
        )
        .sort((a, b) => formatScore(b) - formatScore(a))
        .map((fmt) => makeMergedFormat(fmt, audio))
        .filter((fmt) => fmt.filesize !== null)
    : [];

  const audioOnly = sourceFormats
    .filter((fmt) => hasAudio(fmt) && !hasVideo(fmt))
    .sort((a, b) => formatScore(b) - formatScore(a))
    .map(makeFormat);

  const videoOnly = sourceFormats
    .filter((fmt) => hasVideo(fmt) && !hasAudio(fmt))
    .sort((a, b) => formatScore(b) - formatScore(a))
    .map(makeFormat);

  return [
    ...uniqueByQuality([...nativeCombined, ...mergedCombined]).sort(
      (a, b) => parseInt(b.qualityLabel, 10) - parseInt(a.qualityLabel, 10),
    ),
    ...audioOnly,
    ...uniqueByQuality(videoOnly),
  ];
}

function sanitizeFilename(title: string): string {
  return (
    title
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 100) || "video"
  );
}

function contentDispositionFilename(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function runYtDlpToFile(format: string, url: string, outputTemplate: string): Promise<string> {
  const args = [
    "-f",
    format,
    "--no-playlist",
    "--no-warnings",
    "--concurrent-fragments",
    process.env.YTDLP_CONCURRENT_FRAGMENTS ?? "8",
    ...ytDlpDownloadArgs(),
    ...ytDlpAuthArgs(),
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    url,
  ];

  const { stderr } = await execFileAsync(ytDlpPath, args, { maxBuffer: YTDLP_MAX_BUFFER });
  if (stderr.trim()) {
    // yt-dlp writes progress and warnings to stderr even on success.
  }

  const dir = path.dirname(outputTemplate);
  const prefix = path.basename(outputTemplate).replace(".%(ext)s", "");
  const files = await fs.readdir(dir);
  const output =
    files.find((file) => file === `${prefix}.mp4`) ??
    files.find((file) => file.startsWith(prefix + ".") && !/\.f\d+\./.test(file));

  if (!output) {
    throw new Error("Download finished but no output file was created. If this was a high-quality combined download, install ffmpeg and try again.");
  }

  return path.join(dir, output);
}

function findOutputFile(outputTemplate: string): Promise<string> {
  const dir = path.dirname(outputTemplate);
  const prefix = path.basename(outputTemplate).replace(".%(ext)s", "");
  return fs.readdir(dir).then((files) => {
    const output =
      files.find((file) => file === `${prefix}.mp4`) ??
      files.find((file) => file.startsWith(prefix + ".") && !/\.f\d+\./.test(file));
    if (!output) throw new Error("Download finished but no output file was created.");
    return path.join(dir, output);
  });
}

function updateTaskProgress(task: PrepareTask, text: string): void {
  const progress = text.match(/(\d+(?:\.\d+)?)%/);
  if (progress) {
    task.progress = Math.max(task.progress, Math.min(99, Number(progress[1])));
  }
}

async function mergeFilesToMp4(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  await execFileAsync(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c",
      "copy",
      outputPath,
    ],
    { maxBuffer: YTDLP_MAX_BUFFER },
  );
}

function findOutputFileByPrefix(outputTemplate: string): Promise<string> {
  const dir = path.dirname(outputTemplate);
  const prefix = path.basename(outputTemplate).replace(".%(ext)s", "");
  return fs.readdir(dir).then((files) => {
    const output = files.find((file) => file.startsWith(prefix + "."));
    if (!output) throw new Error("Download finished but no output file was created.");
    return path.join(dir, output);
  });
}

async function downloadFormatPartToFile(
  format: string,
  url: string,
  outputTemplate: string,
  onProgress: (progress: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpPath, [
      "-f",
      format,
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--concurrent-fragments",
      process.env.YTDLP_CONCURRENT_FRAGMENTS ?? "8",
      ...ytDlpDownloadArgs(),
      ...ytDlpAuthArgs(),
      "-o",
      outputTemplate,
      url,
    ]);

    let stderr = "";
    const handleProgress = (text: string) => {
      stderr += text;
      const progress = text.match(/(\d+(?:\.\d+)?)%/);
      if (progress) onProgress(Math.min(100, Number(progress[1])));
    };

    child.stdout.on("data", (d: Buffer) => handleProgress(d.toString()));
    child.stderr.on("data", (d: Buffer) => handleProgress(d.toString()));
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(stderr || "Download preparation failed."));
        return;
      }

      try {
        resolve(await findOutputFileByPrefix(outputTemplate));
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function runParallelMergedPrepare(format: string, url: string, dir: string, task: PrepareTask): Promise<string> {
  task.progress = Math.max(task.progress, 1);
  const [videoFormat, audioFormat] = format.split("+");
  if (!videoFormat || !audioFormat) throw new Error("Merged download format is invalid.");

  const videoTemplate = path.join(dir, "download.video.%(ext)s");
  const audioTemplate = path.join(dir, "download.audio.%(ext)s");
  const outputPath = path.join(dir, "download.mp4");
  const partProgress = [0, 0];
  const setPartProgress = (index: number, progress: number) => {
    partProgress[index] = progress;
    task.progress = Math.max(task.progress, Math.min(92, Math.floor(((partProgress[0] + partProgress[1]) / 200) * 92)));
  };

  const [videoPath, audioPath] = await Promise.all([
    downloadFormatPartToFile(videoFormat, url, videoTemplate, (progress) => setPartProgress(0, progress)),
    downloadFormatPartToFile(audioFormat, url, audioTemplate, (progress) => setPartProgress(1, progress)),
  ]);

  task.progress = Math.max(task.progress, 94);
  await mergeFilesToMp4(videoPath, audioPath, outputPath);
  task.progress = Math.max(task.progress, 99);
  return outputPath;
}

function startPrepareTask(format: string, url: string, title: string): PrepareTask {
  const id = crypto.randomBytes(24).toString("base64url");
  const tempDir = fs.mkdtemp(path.join(os.tmpdir(), "yt-prepare-"));
  const task: PrepareTask = {
    id,
    title,
    tempDir: "",
    outputPath: null,
    progress: 0,
    status: "running",
    error: null,
    createdAt: Date.now(),
  };

  prepareTasks.set(id, task);

  void tempDir
    .then(async (dir) => {
      task.tempDir = dir;

      if (format.includes("+") && process.env.PARALLEL_MERGE_PREPARE !== "false") {
        try {
          task.outputPath = await runParallelMergedPrepare(format, url, dir, task);
          task.progress = 100;
          task.status = "success";
          return;
        } catch {
          task.progress = 0;
        }
      }

      const outputTemplate = path.join(dir, "download.%(ext)s");
      const child = spawn(ytDlpPath, [
        "-f",
        format,
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--concurrent-fragments",
        process.env.YTDLP_CONCURRENT_FRAGMENTS ?? "8",
        ...ytDlpDownloadArgs(),
        ...ytDlpAuthArgs(),
        "--merge-output-format",
        "mp4",
        "-o",
        outputTemplate,
        url,
      ]);

      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        updateTaskProgress(task, d.toString());
      });

      child.stderr.on("data", (d: Buffer) => {
        const text = d.toString();
        stderr += text;
        updateTaskProgress(task, text);
      });

      child.on("error", (err) => {
        task.status = "error";
        task.error = isMissingYtDlpError(err) ? ytDlpSetupMessage() : "Download preparation failed.";
      });

      child.on("close", async (code) => {
        if (code !== 0) {
          task.status = "error";
          task.error = ytDlpErrorMessage(new Error(stderr), "Download preparation failed.");
          return;
        }

        try {
          task.outputPath = await findOutputFile(outputTemplate);
          task.progress = 100;
          task.status = "success";
        } catch (err) {
          task.status = "error";
          task.error = err instanceof Error ? err.message : "Download preparation failed.";
        }
      });
    })
    .catch((err) => {
      task.status = "error";
      task.error = err instanceof Error ? err.message : "Download preparation failed.";
    });

  return task;
}

function sendSse(res: import("express").Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

router.get("/video/info", async (req, res) => {
  const url = parseYoutubeUrl((req.query as { url?: string }).url);

  if (!url) {
    res.status(400).json({ error: "Please provide a valid YouTube URL." });
    return;
  }

  try {
    const cached = getCachedVideoInfo(url);
    if (cached) {
      res.setHeader("X-Video-Info-Cache", "HIT");
      res.setHeader("Cache-Control", "public, max-age=1800, stale-while-revalidate=86400");
      res.json(toPublicVideoInfo(cached));
      return;
    }

    const diskCached = await getDiskCachedVideoInfo(url);
    if (diskCached) {
      res.setHeader("X-Video-Info-Cache", "DISK");
      res.setHeader("Cache-Control", "public, max-age=1800, stale-while-revalidate=86400");
      res.json(toPublicVideoInfo(diskCached));
      return;
    }

    let pending = pendingVideoInfo.get(url);
    if (!pending) {
      pending = fetchVideoInfo(url);
      pendingVideoInfo.set(url, pending);
      pending.finally(() => pendingVideoInfo.delete(url)).catch(() => undefined);
    }

    const videoInfo = await pending;
    res.setHeader("X-Video-Info-Cache", "MISS");
    res.setHeader("Cache-Control", "public, max-age=1800, stale-while-revalidate=86400");
    res.json(toPublicVideoInfo(videoInfo));
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to fetch video info");
    if (isMissingYtDlpError(err)) {
      res.status(500).json({ error: ytDlpSetupMessage() });
      return;
    }
    const message = ytDlpErrorMessage(err, "Failed to fetch video info");
    res.status(500).json({ error: message });
  }
});

async function fetchVideoInfo(url: string): Promise<InternalVideoInfo> {
  const fastInfo = await fetchFastVideoInfo(url);
  if (fastInfo) {
    setCachedVideoInfo(url, fastInfo);
    await setDiskCachedVideoInfo(url, fastInfo);
    return fastInfo;
  }

  const { stdout } = await execFileAsync(
    ytDlpPath,
    ["--dump-json", "--no-playlist", "--no-warnings", ...ytDlpInfoArgs(), ...ytDlpAuthArgs(), url],
    { maxBuffer: YTDLP_MAX_BUFFER },
  );

  const info: YtDlpInfo = JSON.parse(stdout);

  const thumbnail =
    info.thumbnails
      ?.filter((t) => t.url)
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ??
    info.thumbnail;

  const result = {
    videoId: info.id,
    title: info.title,
    author: info.uploader ?? "Unknown",
    thumbnailUrl: thumbnail,
    durationSeconds: Math.round(info.duration ?? 0),
    viewCount: info.view_count ?? null,
    formats: buildFormats(info),
  };

  setCachedVideoInfo(url, result);
  await setDiskCachedVideoInfo(url, result);
  return result;
}

async function fetchFastVideoInfo(url: string): Promise<InternalVideoInfo | null> {
  if (process.env.YOUTUBEI_FAST_INFO === "false") return null;

  const videoId = videoIdFromUrl(url);
  if (!videoId) return null;

 // ✅ REPLACE WITH — WEB client gets DASH formats
const clients = [
  {
    body: {
      context: {
        client: {
          clientName: "WEB",
          clientVersion: "2.20240726.00.00",
          hl: "en",
          gl: "US",
        },
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
  {
    body: {
      context: {
        client: {
          clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
          clientVersion: "2.0",
          hl: "en",
          gl: "US",
        },
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    },
    userAgent: "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1",
  },
];

  for (const client of clients) {
    try {
      const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": client.userAgent,
        },
        body: JSON.stringify(client.body),
      });

      if (!response.ok) continue;

      const player = (await response.json()) as YoutubeiPlayerResponse;
      if (player.playabilityStatus?.status !== "OK" || !player.videoDetails?.title) continue;

      const sourceFormats = [
        ...(player.streamingData?.formats ?? []),
        ...(player.streamingData?.adaptiveFormats ?? []),
      ]
        .map(youtubeiFormatToYtDlpFormat)
        .filter((format): format is YtDlpFormat => Boolean(format));

      if (sourceFormats.length === 0) continue;

      const thumbnails = player.videoDetails.thumbnail?.thumbnails ?? [];
      const thumbnail =
        thumbnails
          .filter((t) => t.url)
          .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? "";

      const result = {
        videoId: player.videoDetails.videoId ?? videoId,
        title: player.videoDetails.title,
        author: player.videoDetails.author ?? "Unknown",
        thumbnailUrl: thumbnail,
        durationSeconds: Number(player.videoDetails.lengthSeconds ?? 0) || 0,
        viewCount: player.videoDetails.viewCount ? Number(player.videoDetails.viewCount) : null,
        formats: buildFormats({
          id: player.videoDetails.videoId ?? videoId,
          title: player.videoDetails.title,
          uploader: player.videoDetails.author,
          thumbnail,
          duration: Number(player.videoDetails.lengthSeconds ?? 0) || 0,
          view_count: player.videoDetails.viewCount ? Number(player.videoDetails.viewCount) : null,
          formats: sourceFormats,
        }),
      };

      if (!hasSafeFastVideoInfo(result)) continue;
      return result;
    } catch {
      continue;
    }
  }

  return null;
}

async function getDirectDownloadUrl(url: string, itag: string): Promise<string | undefined> {
  const cached = getCachedVideoInfo(url) ?? (await getDiskCachedVideoInfo(url));
  const format = cached?.formats.find((item) => item.itag === itag);
  return format && cached && isSafeDirectDownloadFormat(format) && hasPlausibleMediaFileSize(format, cached.durationSeconds)
    ? format.directUrl
    : undefined;
}

async function getRequiredDirectDownloadUrl(url: string, itag: string): Promise<string> {
  const cached = getCachedVideoInfo(url) ?? (await getDiskCachedVideoInfo(url)) ?? (await fetchVideoInfo(url));
  const format = cached.formats.find((item) => item.itag === itag);
  if (!format || !isSafeDirectDownloadFormat(format) || !hasPlausibleMediaFileSize(format, cached.durationSeconds)) {
    throw new Error(`Could not create a direct stream URL for format ${itag}.`);
  }
  return format.directUrl;
}

async function getYtDlpStreamUrls(url: string, itag: string): Promise<{ videoUrl: string; audioUrl: string }> {
  const { stdout } = await execFileAsync(
    ytDlpPath,
    ["-g", "-f", itag, "--no-playlist", "--no-warnings", ...ytDlpInfoArgs(), ...ytDlpAuthArgs(), url],
    { maxBuffer: YTDLP_MAX_BUFFER },
  );
  const [videoUrl, audioUrl] = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!videoUrl || !audioUrl) throw new Error("Could not resolve media stream URLs for live merge.");
  return { videoUrl, audioUrl };
}

async function streamMergedDownload(
  req: import("express").Request,
  res: import("express").Response,
  url: string,
  itag: string,
  title: string,
): Promise<void> {
  const [videoItag, audioItag] = itag.split("+");
  if (!videoItag || !audioItag) throw new Error("Merged download format is invalid.");

  const { videoUrl, audioUrl } = await getYtDlpStreamUrls(url, itag);

  res.setHeader("Content-Disposition", contentDispositionFilename(`${title}.mp4`));
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");

  const child = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-user_agent",
    "com.google.android.youtube/20.10.38 (Linux; U; Android 12) gzip",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-i",
    videoUrl,
    "-i",
    audioUrl,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c",
    "copy",
    "-movflags",
    "frag_keyframe+empty_moov",
    "-f",
    "mp4",
    "pipe:1",
  ]);

  let stderr = "";

  res.on("close", () => {
    if (!res.writableEnded && !child.killed) child.kill();
  });

  child.stdout.pipe(res);
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  child.on("error", (err) => {
    req.log.error({ err }, "ffmpeg stream spawn error");
    if (!res.headersSent) res.status(500).json({ error: "Merged download failed to start." });
  });
  child.on("close", (code) => {
    if (code === 0) return;
    req.log.error({ code, stderr }, "ffmpeg stream failed");
    if (!res.headersSent) res.status(500).json({ error: "Merged download failed." });
  });
}

async function streamDirectDownload(
  req: import("express").Request,
  res: import("express").Response,
  directUrl: string,
  title: string,
): Promise<void> {
  const controller = new AbortController();
  const upstream = await fetch(directUrl, {
    signal: controller.signal,
    headers: {
      "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 12) gzip",
    },
  });

  if (!upstream.ok || !upstream.body) {
    throw new Error(`Direct download URL returned ${upstream.status}.`);
  }

  res.setHeader("Content-Disposition", contentDispositionFilename(`${title}.mp4`));
  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");

  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);

  res.on("close", () => controller.abort());

  const stream = Readable.fromWeb(upstream.body);
  stream.on("error", (err) => {
    req.log.error({ err }, "Direct download stream failed");
    res.destroy(err);
  });
  stream.pipe(res);
}

router.post("/video/download-token", async (req, res) => {
  const body = req.body as { url?: string; itag?: string; title?: string };
  const url = parseYoutubeUrl(body.url);
  const itag = body.itag?.trim();

  if (!url || !itag) {
    res.status(400).json({ error: "url and itag are required" });
    return;
  }

  const token = createVideoDownloadToken({
    url,
    itag,
    title: sanitizeFilename(body.title ?? "video"),
    directUrl: itag.includes("+") ? undefined : await getDirectDownloadUrl(url, itag),
  });

  res.json({
    token,
    url: `/api/video/download?token=${encodeURIComponent(token)}`,
    expiresInSeconds: 600,
  });
});

router.post("/video/prepare-download", (req, res) => {
  const body = req.body as { url?: string; itag?: string; title?: string };
  const url = parseYoutubeUrl(body.url);
  const itag = body.itag?.trim();

  if (!url || !itag) {
    res.status(400).json({ error: "url and itag are required" });
    return;
  }

  const task = startPrepareTask(itag, url, sanitizeFilename(body.title ?? "video"));
  res.json({
    taskId: task.id,
    eventsUrl: `/api/video/prepare-download/events?taskId=${encodeURIComponent(task.id)}`,
  });
});

router.get("/video/prepare-download/events", (req, res) => {
  const { taskId } = req.query as { taskId?: string };
  const task = taskId ? prepareTasks.get(taskId) : null;

  if (!task) {
    res.status(404).json({ error: "Preparation task not found." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = () => {
    const payload = {
      status: task.status,
      progress: Math.round(task.progress),
      error: task.error,
      downloadUrl:
        task.status === "success"
          ? `/api/video/prepared-download?taskId=${encodeURIComponent(task.id)}`
          : "",
    };

    sendSse(
      res,
      task.status === "success" ? "success" : task.status === "error" ? "failed" : "running",
      payload,
    );
  };

  const interval = setInterval(() => {
    send();
    if (task.status !== "running") {
      clearInterval(interval);
      res.end();
    }
  }, 1000);

  send();

  req.on("close", () => {
    clearInterval(interval);
  });
});

router.get("/video/prepared-download", async (req, res) => {
  const { taskId } = req.query as { taskId?: string };
  const task = taskId ? prepareTasks.get(taskId) : null;

  if (!task || task.status !== "success" || !task.outputPath) {
    res.status(404).json({ error: "Prepared download is not ready or has expired." });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.download(task.outputPath, `${task.title}.mp4`, async () => {
    prepareTasks.delete(task.id);
    if (task.tempDir) await fs.rm(task.tempDir, { recursive: true, force: true });
  });
});

router.get("/video/download", async (req, res) => {
  const { token } = req.query as { token?: string };
  const payload = token ? consumeVideoDownloadToken(token) : null;
  const url = payload?.url ?? null;
  const itag = payload?.itag;

  if (!url || !itag) {
    res.status(400).json({ error: "Download link is invalid, expired, or already used. Please click Download again." });
    return;
  }

  let outputPath: string | null = null;

  try {
    const safeTitle = payload.title || "video";
    const isMergedFormat = itag.includes("+");

    if (!isMergedFormat && payload.directUrl) {
      try {
        await streamDirectDownload(req, res, payload.directUrl, safeTitle);
        return;
      } catch (err) {
        req.log.warn({ err }, "Direct URL stream failed; falling back to yt-dlp pipe");
      }
    }

    if (isMergedFormat) {
      await streamMergedDownload(req, res, url, itag, safeTitle);
      return;
    }

    res.setHeader("Content-Disposition", contentDispositionFilename(`${safeTitle}.mp4`));
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");

    const child = spawn(ytDlpPath, [
      "-f",
      itag,
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--concurrent-fragments",
      process.env.YTDLP_CONCURRENT_FRAGMENTS ?? "8",
      ...ytDlpDownloadArgs(),
      ...ytDlpAuthArgs(),
      "-o",
      "-",
      url,
    ]);

    let stderr = "";

    res.on("close", () => {
      if (!res.writableEnded && !child.killed) child.kill();
    });

    child.stdout.pipe(res);
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      req.log.warn({ msg: d.toString() }, "yt-dlp stderr");
    });
    child.on("error", (err) => {
      req.log.error({ err }, "yt-dlp spawn error");
      const message = isMissingYtDlpError(err) ? ytDlpSetupMessage() : "Download failed";
      if (!res.headersSent) res.status(500).json({ error: message });
    });
    child.on("close", (code) => {
      if (code === 0) return;
      req.log.error({ code, stderr }, "yt-dlp download failed");
      if (!res.headersSent) res.status(500).json({ error: ytDlpErrorMessage(new Error(stderr), "Download failed") });
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to initiate download");
    if (outputPath) {
      await fs.rm(path.dirname(outputPath), { recursive: true, force: true });
    }
    if (isMissingYtDlpError(err)) {
      if (!res.headersSent) res.status(500).json({ error: ytDlpSetupMessage() });
      return;
    }
    const message = ytDlpErrorMessage(err, "Failed to initiate download");
    if (!res.headersSent) res.status(500).json({ error: message });
  }
});

export default router;
