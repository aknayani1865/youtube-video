import { Router } from "express";
import { execFile } from "child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "util";
import archiver from "archiver";
import { createPlaylistDownloadToken, consumePlaylistDownloadToken } from "../lib/downloadTokens";
import { isMissingYtDlpError, ytDlpAuthArgs, ytDlpDownloadArgs, ytDlpErrorMessage, ytDlpInfoArgs, ytDlpPath, ytDlpSetupMessage } from "../lib/ytdlp";

const execFileAsync = promisify(execFile);
const router = Router();

interface FlatEntry {
  id: string;
  title?: string;
  uploader?: string;
  channel?: string;
  thumbnail?: string;
  thumbnails?: { url: string; width?: number; height?: number }[];
  duration?: number | null;
  url?: string;
  webpage_url?: string;
}

type PlaylistMeta = {
  playlist_id?: string;
  playlist_title?: string;
  playlist_uploader?: string;
  title?: string;
  uploader?: string;
  channel?: string;
};

function bestThumbnail(entry: FlatEntry): string {
  if (entry.thumbnails?.length) {
    const sorted = [...entry.thumbnails]
      .filter((t) => t.url)
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    if (sorted[0]) return sorted[0].url;
  }
  return entry.thumbnail ?? (entry.id ? `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg` : "");
}

function playlistVideoUrl(entry: FlatEntry): string {
  if (entry.webpage_url?.startsWith("http")) return entry.webpage_url;
  if (entry.url?.startsWith("http")) return entry.url;
  const id = entry.id || entry.url;
  return id ? `https://www.youtube.com/watch?v=${id}` : "https://www.youtube.com";
}

function safeFilename(title: string, ext: string): string {
  return (
    title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 80) || "video"
  ) + `.${ext}`;
}

async function downloadPlaylistEntryToFile(format: string, videoUrl: string, outputTemplate: string, isAudio: boolean): Promise<string> {
  const args = [
    "-f",
    format,
    "--no-playlist",
    "--no-warnings",
    "--concurrent-fragments",
    process.env.YTDLP_CONCURRENT_FRAGMENTS ?? "8",
    ...ytDlpDownloadArgs(),
    ...ytDlpAuthArgs(),
    "-o",
    outputTemplate,
  ];

  if (!isAudio) {
    args.push("--merge-output-format", "mp4");
  }

  args.push(videoUrl);

  await execFileAsync(ytDlpPath, args, { maxBuffer: 50 * 1024 * 1024 });

  const dir = path.dirname(outputTemplate);
  const prefix = path.basename(outputTemplate).replace(".%(ext)s", "");
  const files = await fs.readdir(dir);
  const output =
    files.find((file) => file === `${prefix}.mp4`) ??
    files.find((file) => file.startsWith(prefix + ".") && !/\.f\d+\./.test(file));

  if (!output) {
    throw new Error("Playlist video download finished but no output file was created.");
  }

  return path.join(dir, output);
}

const QUALITY_FORMATS: Record<string, string> = {
  best: "bestvideo+bestaudio/best",
  "2160p": "bestvideo[height<=2160]+bestaudio/bestvideo[height<=2160]/best",
  "1440p": "bestvideo[height<=1440]+bestaudio/bestvideo[height<=1440]/best",
  "1080p": "bestvideo[height<=1080]+bestaudio/bestvideo[height<=1080]/best",
  "720p": "bestvideo[height<=720]+bestaudio/bestvideo[height<=720]/best",
  "480p": "bestvideo[height<=480]+bestaudio/bestvideo[height<=480]/best",
  "360p": "bestvideo[height<=360]+bestaudio/bestvideo[height<=360]/best",
  "240p": "bestvideo[height<=240]+bestaudio/bestvideo[height<=240]/best",
  "144p": "bestvideo[height<=144]+bestaudio/bestvideo[height<=144]/best",
  audio: "bestaudio[ext=m4a]/bestaudio",
};

// GET /playlist/info

router.get("/playlist/info", async (req, res) => {
  const { url } = req.query as { url?: string };

  if (!url) { res.status(400).json({ error: "url query parameter is required" }); return; }
  if (!url.includes("youtube.com") && !url.includes("youtu.be")) {
    res.status(400).json({ error: "Invalid YouTube URL" }); return;
  }

  try {
    const { stdout } = await execFileAsync(
      ytDlpPath,
      ["--flat-playlist", "--dump-json", "--yes-playlist", "--no-warnings", ...ytDlpInfoArgs(), ...ytDlpAuthArgs(), url],
      { maxBuffer: 50 * 1024 * 1024 }
    );

    const lines = stdout.trim().split("\n").filter(Boolean);
    const entries: (FlatEntry & PlaylistMeta)[] = lines.map((l) => JSON.parse(l));

    if (entries.length === 0) { res.status(400).json({ error: "No videos found in playlist" }); return; }

    const first = entries[0];
    const videos = entries.map((entry) => ({
      videoId: entry.id,
      title: entry.title ?? "Untitled",
      author: entry.uploader ?? entry.channel ?? "Unknown",
      thumbnailUrl: bestThumbnail(entry),
      durationSeconds: entry.duration != null ? Math.round(entry.duration) : null,
      url: playlistVideoUrl(entry),
    }));

    res.json({
      playlistId: first.playlist_id ?? "playlist",
      title: first.playlist_title ?? first.title ?? "Playlist",
      author: first.playlist_uploader ?? first.uploader ?? first.channel ?? "Unknown",
      videoCount: videos.length,
      videos,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to fetch playlist info");
    if (isMissingYtDlpError(err)) {
      res.status(500).json({ error: ytDlpSetupMessage() });
      return;
    }
    res.status(500).json({ error: ytDlpErrorMessage(err, "Failed to fetch playlist info") });
  }
});

// GET /playlist/download

router.post("/playlist/download-token", (req, res) => {
  const body = req.body as { url?: string; quality?: string };
  const url = body.url?.trim();
  const quality = body.quality?.trim() || "best";

  if (!url) { res.status(400).json({ error: "url is required" }); return; }
  if (!url.includes("youtube.com") && !url.includes("youtu.be")) {
    res.status(400).json({ error: "Invalid YouTube URL" }); return;
  }

  const token = createPlaylistDownloadToken({
    url,
    quality: QUALITY_FORMATS[quality] ? quality : "best",
  });

  res.json({
    token,
    url: `/api/playlist/download?token=${encodeURIComponent(token)}`,
    expiresInSeconds: 600,
  });
});

router.get("/playlist/download", async (req, res) => {
  const { token } = req.query as { token?: string };
  const payload = token ? consumePlaylistDownloadToken(token) : null;
  const url = payload?.url;
  const quality = payload?.quality ?? "best";

  if (!url) { res.status(400).json({ error: "Download link is invalid, expired, or already used. Please click Download ZIP again." }); return; }
  if (!url.includes("youtube.com") && !url.includes("youtu.be")) {
    res.status(400).json({ error: "Invalid YouTube URL" }); return;
  }

  const formatStr = QUALITY_FORMATS[quality] ?? QUALITY_FORMATS["best"];
  const isAudio = quality === "audio";

  // 1. Fetch flat playlist to get video list
  let entries: (FlatEntry & PlaylistMeta)[];
  try {
    const { stdout } = await execFileAsync(
      ytDlpPath,
      ["--flat-playlist", "--dump-json", "--yes-playlist", "--no-warnings", ...ytDlpInfoArgs(), ...ytDlpAuthArgs(), url],
      { maxBuffer: 50 * 1024 * 1024 }
    );
    entries = stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    req.log.error({ err }, "Failed to list playlist for download");
    res.status(500).json({ error: ytDlpErrorMessage(err, "Failed to fetch playlist") });
    return;
  }

  if (entries.length === 0) { res.status(400).json({ error: "No videos found in playlist" }); return; }

  const first = entries[0];
  const playlistTitle = (first.playlist_title ?? first.title ?? "playlist")
    .replace(/[<>:"/\\|?*]/g, "").trim() || "playlist";

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-playlist-"));
  const cleanup = async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  };

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${playlistTitle}.zip"`);
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");

  const archive = archiver("zip", { zlib: { level: 0 } });
  archive.pipe(res);

  archive.on("error", (err) => {
    req.log.error({ err }, "Archiver error");
  });
  res.on("close", () => void cleanup());

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const videoUrl = playlistVideoUrl(entry);
    const title = entry.title ?? `video_${i + 1}`;
    const outputTemplate = path.join(tempDir, `${String(i + 1).padStart(3, "0")}.%(ext)s`);

    req.log.info({ video: entry.id, idx: i + 1, total: entries.length, quality }, "Downloading video for ZIP");

    try {
      const outputPath = await downloadPlaylistEntryToFile(formatStr, videoUrl, outputTemplate, isAudio);
      const ext = path.extname(outputPath).slice(1) || (isAudio ? "m4a" : "mp4");
      const filename = `${String(i + 1).padStart(2, "0")}_${safeFilename(title, ext)}`;
      archive.file(outputPath, { name: filename });
    } catch (err) {
      req.log.error({ err, video: entry.id }, "Failed to download video for ZIP");
    }
  }

  await archive.finalize();
});

export default router;
