import { useState, useEffect, useCallback } from "react";
import {
  Search, Youtube, Play, HardDrive, Music, Video,
  ArrowDownToLine, ShieldCheck, Zap, Clock, Eye,
  Sun, Moon, History, Star, X, Filter,
  ListVideo, ChevronLeft, Users, Package, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  useGetVideoInfo, getGetVideoInfoQueryKey,
  useGetPlaylistInfo, getGetPlaylistInfoQueryKey,
  type VideoFormat, type PlaylistVideo,
} from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { useTheme } from "@/components/theme-provider";
import { absoluteApiUrl, apiUrl } from "@/lib/api-base";

// constants & helpers

const HISTORY_KEY = "vidssave-history";
const MAX_HISTORY = 8;
const SMARTLINK_URL = "https://heavenlysuspicious.com/jmt7hb54f5?key=9f34ad9e56c5178e25362e0df5c40833";

function isPlaylistUrl(url: string): boolean {
  try {
    const p = new URL(url);
    return (
      p.hostname.includes("youtube.com") &&
      (p.searchParams.has("list") || p.pathname === "/playlist")
    );
  } catch {
    return false;
  }
}

function normalizeYoutubeInput(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

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
    if (!isYoutubeHost && !isShortHost) return null;

    const list = url.searchParams.get("list");

    if (list) {
      return `https://www.youtube.com/playlist?list=${list}`;
    }

    if (isShortHost) {
      const videoId = url.pathname.split("/").filter(Boolean)[0];
      return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    }

    const directVideoId = url.searchParams.get("v");
    const pathVideoId = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1];
    const videoId = directVideoId ?? pathVideoId;

    if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;

    return null;
  } catch {
    return null;
  }
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null) return "--:--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatViews(views: number | null | undefined) {
  if (!views) return null;
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M`;
  if (views >= 1_000) return `${(views / 1_000).toFixed(1)}K`;
  return views.toLocaleString();
}

function formatSize(bytes: number | null | undefined): string | null {
  if (!bytes) return null;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1000) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

function isPreparedFormat(format: VideoFormat): boolean {
  return format.itag.includes("+");
}

function pickBest(formats: VideoFormat[]): VideoFormat[] {
  if (formats.length === 0) return [];
  return [formats[0]];
}

// history hook

interface HistoryItem {
  videoId: string;
  title: string;
  author: string;
  thumbnailUrl: string;
  durationSeconds: number;
  url: string;
  savedAt: number;
}

function useHistory() {
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); }
    catch { return []; }
  });

  const addToHistory = useCallback((item: HistoryItem) => {
    setHistory((prev) => {
      const next = [item, ...prev.filter((h) => h.videoId !== item.videoId)].slice(0, MAX_HISTORY);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const removeFromHistory = useCallback((videoId: string) => {
    setHistory((prev) => {
      const next = prev.filter((h) => h.videoId !== videoId);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    localStorage.removeItem(HISTORY_KEY);
    setHistory([]);
  }, []);

  return { history, addToHistory, removeFromHistory, clearHistory };
}

async function createVideoDownloadLink(url: string, itag: string, title: string): Promise<string> {
  const response = await fetch(apiUrl("/api/video/download-token"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, itag, title }),
  });

  const data = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!response.ok || !data?.url) {
    throw new Error(data?.error ?? "Could not create secure download link.");
  }

  return absoluteApiUrl(data.url);
}

async function createVideoPrepareTask(url: string, itag: string, title: string): Promise<string> {
  const response = await fetch(apiUrl("/api/video/prepare-download"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, itag, title }),
  });

  const data = (await response.json().catch(() => null)) as { eventsUrl?: string; error?: string } | null;
  if (!response.ok || !data?.eventsUrl) {
    throw new Error(data?.error ?? "Could not prepare this download.");
  }

  return absoluteApiUrl(data.eventsUrl);
}

async function createPlaylistDownloadLink(url: string, quality: string): Promise<string> {
  const response = await fetch(apiUrl("/api/playlist/download-token"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, quality }),
  });

  const data = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!response.ok || !data?.url) {
    throw new Error(data?.error ?? "Could not create secure playlist download link.");
  }

  return absoluteApiUrl(data.url);
}

function triggerBrowserDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noreferrer";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

type PrepareDialogState = {
  open: boolean;
  status: "running" | "success" | "error";
  progress: number;
  downloadUrl: string;
  error: string;
  quality: string;
  container: string;
};

// three-dot loader

function ThreeDotLoader() {
  return (
    <motion.div key="loader" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      className="flex justify-center items-center gap-2 py-4"
    >
      {[0, 1, 2].map((i) => (
        <motion.span key={i} className="block w-2.5 h-2.5 rounded-full bg-primary"
          animate={{ y: [0, -8, 0] }}
          transition={{ duration: 0.55, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
        />
      ))}
    </motion.div>
  );
}

// main page

export default function Home() {
  const [inputValue, setInputValue] = useState("");
  const [submittedUrl, setSubmittedUrl] = useState("");
  const [singleVideoUrl, setSingleVideoUrl] = useState("");
  const [bestOnly, setBestOnly] = useState(false);
  const [zipQuality, setZipQuality] = useState("best");
  const [prepareDialog, setPrepareDialog] = useState<PrepareDialogState | null>(null);

  const { toast } = useToast();
  const { theme, setTheme } = useTheme();
  const { history, addToHistory, removeFromHistory, clearHistory } = useHistory();

  const playlist = isPlaylistUrl(submittedUrl);

  // single-video query
  const effectiveVideoUrl = singleVideoUrl || (!playlist ? submittedUrl : "");
  const {
    data: videoInfo,
    isLoading: videoLoading,
    error: videoError,
    isError: videoIsError,
  } = useGetVideoInfo(
    { url: effectiveVideoUrl },
    { query: { enabled: !!effectiveVideoUrl, queryKey: getGetVideoInfoQueryKey({ url: effectiveVideoUrl }), retry: false } }
  );

  // playlist query
  const {
    data: playlistInfo,
    isLoading: playlistLoading,
    error: playlistError,
    isError: playlistIsError,
  } = useGetPlaylistInfo(
    { url: submittedUrl },
    { query: { enabled: !!submittedUrl && playlist, queryKey: getGetPlaylistInfoQueryKey({ url: submittedUrl }), retry: false } }
  );

  const isLoading = videoLoading || playlistLoading;

  // Save to history when video loads
  useEffect(() => {
    if (videoInfo && effectiveVideoUrl) {
      addToHistory({
        videoId: videoInfo.videoId,
        title: videoInfo.title,
        author: videoInfo.author,
        thumbnailUrl: videoInfo.thumbnailUrl,
        durationSeconds: videoInfo.durationSeconds,
        url: effectiveVideoUrl,
        savedAt: Date.now(),
      });
    }
  }, [videoInfo, effectiveVideoUrl, addToHistory]);

  const trySubmit = (url: string) => {
    const normalized = normalizeYoutubeInput(url);
    if (!normalized) {
      toast({ title: "Invalid URL", description: "Please enter a valid YouTube URL.", variant: "destructive" });
      return;
    }
    setInputValue(normalized);
    setSingleVideoUrl("");
    setSubmittedUrl(normalized);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    trySubmit(inputValue);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    const normalized = normalizeYoutubeInput(pasted);
    if (normalized) {
      e.preventDefault();
      setInputValue(normalized);
      setTimeout(() => trySubmit(normalized), 0);
    }
  };

  const handleVideoDownload = async (itag: string) => {
    const dlUrl = singleVideoUrl || effectiveVideoUrl;
    if (!dlUrl) return;

    const format = allFormats.find((f) => f.itag === itag);
    if (!format) return;

    if (isPreparedFormat(format)) {
      setPrepareDialog({
        open: true,
        status: "running",
        progress: 0,
        downloadUrl: "",
        error: "",
        quality: format.qualityLabel,
        container: format.container,
      });

      try {
        const eventsUrl = await createVideoPrepareTask(dlUrl, itag, videoInfo?.title ?? "video");
        const events = new EventSource(eventsUrl);
       const update = (event: MessageEvent) => {
  const data = JSON.parse(event.data) as {
    status: "running" | "success" | "error";
    progress: number;
    downloadUrl?: string;
    error?: string;
  };

  setPrepareDialog((current) =>
    current
      ? {
          ...current,
          status: data.status,
          progress: Math.max(current.progress, data.progress ?? 0),
          downloadUrl: data.downloadUrl
            ? absoluteApiUrl(data.downloadUrl)
            : current.downloadUrl,
          error: data.error ?? "",
        }
      : current,
  );

  if (data.status !== "running") events.close();
};

        events.addEventListener("running", update);
        events.addEventListener("success", update);
        events.addEventListener("failed", update);
        events.onerror = () => {
          events.close();
          setPrepareDialog((current) => current ? {
            ...current,
            status: "error",
            error: current.error || "Connection lost while preparing this download.",
          } : current);
        };
      } catch (err) {
        setPrepareDialog((current) => current ? {
          ...current,
          status: "error",
          error: err instanceof Error ? err.message : "Could not prepare this download.",
        } : current);
      }

      return;
    }

    try {
      const link = await createVideoDownloadLink(dlUrl, itag, videoInfo?.title ?? "video");
      triggerBrowserDownload(link);
      toast({ title: "Download started", description: "Fast format is downloading now." });
    } catch (err) {
      toast({
        title: "Download failed",
        description: err instanceof Error ? err.message : "Could not create secure download link.",
        variant: "destructive",
      });
    }
  };

  const loadFromHistory = (item: HistoryItem) => {
    setInputValue(item.url);
    setSingleVideoUrl("");
    setSubmittedUrl(item.url);
  };

  const openPlaylistVideo = (v: PlaylistVideo) => {
    setSingleVideoUrl(v.url);
  };

  const backToPlaylist = () => {
    setSingleVideoUrl("");
  };

  const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  const allFormats = videoInfo?.formats ?? [];
  const displayCombined = bestOnly ? pickBest(allFormats.filter((f) => f.hasVideo && f.hasAudio)) : allFormats.filter((f) => f.hasVideo && f.hasAudio);
  const displayAudio    = bestOnly ? pickBest(allFormats.filter((f) => !f.hasVideo && f.hasAudio)) : allFormats.filter((f) => !f.hasVideo && f.hasAudio);
  const displayVideo    = bestOnly ? pickBest(allFormats.filter((f) => f.hasVideo && !f.hasAudio)) : allFormats.filter((f) => f.hasVideo && !f.hasAudio);

  const showHistory = history.length > 0 && !submittedUrl && !isLoading;

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col relative overflow-x-hidden">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[min(600px,100vw)] h-[260px] sm:h-[300px] bg-primary/8 rounded-full blur-[100px] pointer-events-none" />

      {/* Header */}
      <header className="w-full px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border/30 backdrop-blur-md sticky top-0 z-50 bg-background/80">
        <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
          <Youtube className="w-5 h-5 text-primary" />
          <span>vids<span className="text-primary">save</span></span>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-4 text-xs text-muted-foreground font-medium">
            <span className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5 text-primary" /> Fast</span>
            <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-primary" /> Secure</span>
          </div>
          <Button variant="ghost" size="icon" data-testid="button-theme-toggle"
            onClick={() => setTheme(isDark ? "light" : "dark")}
            className="rounded-full w-8 h-8 text-muted-foreground hover:text-foreground"
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-8 sm:py-10 flex flex-col gap-7 sm:gap-8">

        {/* Hero + Search */}
        <section className="flex flex-col items-center text-center gap-5">
          <h1 className="text-[2.45rem] leading-[1.12] sm:text-5xl font-bold tracking-tight max-w-[12ch] sm:max-w-none">
            Download <span className="text-primary">YouTube</span> Videos and Playlist
          </h1>
          <p className="text-muted-foreground text-base max-w-sm leading-relaxed">
            Paste a YouTube video or playlist link, pick video or audio quality, and download instantly.
          </p>

          <form onSubmit={handleSubmit} data-testid="form-search" className="w-full mt-2 flex flex-col min-[460px]:flex-row gap-2">
            <div className="relative flex-1 min-w-0 group">
              <div className="absolute inset-0 rounded-xl bg-primary/15 blur-md opacity-0 group-focus-within:opacity-100 transition-opacity duration-500 pointer-events-none" />
              <div className="relative flex items-center bg-card border border-border/50 rounded-xl transition-colors focus-within:border-primary/60">
                <div className="pl-4 text-muted-foreground shrink-0">
                  <Search className="w-4 h-4" />
                </div>
                <Input type="url" value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onPaste={handlePaste}
                  placeholder="Video or playlist URL..."
                  data-testid="input-url"
                  className="border-0 focus-visible:ring-0 bg-transparent h-12 text-sm placeholder:text-muted-foreground/50 w-full min-w-0"
                />
              </div>
            </div>
            <Button type="submit" size="lg" data-testid="button-extract" disabled={isLoading}
              className="h-12 px-6 rounded-xl font-semibold shadow-md shadow-primary/20 hover:shadow-primary/30 transition-all active:scale-[0.97] shrink-0 w-full min-[460px]:w-auto"
            >
              {isLoading ? "Loading..." : "Extract"}
            </Button>
          </form>

        </section>

        {/* Loader */}
        <AnimatePresence>{isLoading && <ThreeDotLoader />}</AnimatePresence>

        {/* Video error */}
        <AnimatePresence>
          {videoIsError && !videoLoading && !playlist && (
            <motion.div key="verr" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
              className="p-5 rounded-2xl bg-destructive/10 border border-destructive/20 text-destructive text-center"
            >
              <p className="font-semibold mb-1">Could not load video</p>
              <p className="text-sm opacity-80">{videoError?.data?.error ?? videoError?.message ?? "Check the URL and try again."}</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Playlist error */}
        <AnimatePresence>
          {playlistIsError && !playlistLoading && playlist && !singleVideoUrl && (
            <motion.div key="perr" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
              className="p-5 rounded-2xl bg-destructive/10 border border-destructive/20 text-destructive text-center"
            >
              <p className="font-semibold mb-1">Could not load playlist</p>
              <p className="text-sm opacity-80">{playlistError?.data?.error ?? playlistError?.message ?? "Check the URL and try again."}</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Recent History */}
        <AnimatePresence>
          {showHistory && (
            <motion.section key="history" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="flex flex-col gap-3"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5" /> Recent
                </h2>
                <button onClick={clearHistory} data-testid="button-clear-history"
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                >Clear all</button>
              </div>
              <div className="grid gap-2">
                {history.map((item) => (
                  <motion.div key={item.videoId} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border/40 hover:border-primary/30 transition-all group min-w-0"
                  >
                    <div className="w-16 h-10 sm:w-18 sm:h-11 rounded-lg overflow-hidden bg-secondary shrink-0 cursor-pointer" onClick={() => loadFromHistory(item)}>
                      <img src={item.thumbnailUrl} alt={item.title} className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => loadFromHistory(item)} data-testid={`history-item-${item.videoId}`}>
                      <p className="text-sm font-medium truncate leading-tight">{item.title}</p>
                      <p className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-0.5 min-w-0">
                        <span className="truncate min-w-0">{item.author}</span>
                        <span className="opacity-40">-</span>
                        <Clock className="w-3 h-3 shrink-0" />
                        <span className="shrink-0">{formatDuration(item.durationSeconds)}</span>
                      </p>
                    </div>
                    <button onClick={() => removeFromHistory(item.videoId)} data-testid={`button-remove-history-${item.videoId}`}
                      className="p-1 rounded-lg text-muted-foreground hover:text-destructive opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all shrink-0"
                    ><X className="w-3.5 h-3.5" /></button>
                  </motion.div>
                ))}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* PLAYLIST VIEW */}
        <AnimatePresence>
          {playlistInfo && !playlistLoading && playlist && !singleVideoUrl && (
            <motion.div key="playlist" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: "easeOut" }} className="flex flex-col gap-5"
            >
              {/* Playlist header */}
              <div className="flex flex-col gap-3 p-4 rounded-2xl bg-card border border-border/40">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
                    <ListVideo className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="font-bold text-lg leading-tight truncate" data-testid="text-playlist-title">
                      {playlistInfo.title}
                    </h2>
                    <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" />{playlistInfo.author}</span>
                      <span className="flex items-center gap-1"><ListVideo className="w-3.5 h-3.5" />{playlistInfo.videoCount} videos</span>
                    </div>
                  </div>
                </div>

                {/* Download All as ZIP */}
                <div className="flex items-center gap-2 pt-1 border-t border-border/40">
                  <div className="flex-1">
                    <p className="text-xs text-muted-foreground mb-1.5 font-medium">Download all as ZIP</p>
                    <p className="text-[11px] text-muted-foreground mb-2 leading-snug">
                      ZIP downloads need server packaging first, so large playlists or HD quality can take longer before the browser download starts.
                    </p>
                    <div className="flex flex-col min-[460px]:flex-row min-[460px]:items-center gap-2">
                      <Select value={zipQuality} onValueChange={setZipQuality}>
                        <SelectTrigger data-testid="select-zip-quality" className="h-10 min-[460px]:h-9 text-xs rounded-lg flex-1 border-border/50 bg-background w-full min-w-0">
                          <SelectValue placeholder="Quality" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="best">Best Quality</SelectItem>
                          <SelectItem value="2160p">2160p 4K</SelectItem>
                          <SelectItem value="1440p">1440p 2K</SelectItem>
                          <SelectItem value="1080p">1080p HD</SelectItem>
                          <SelectItem value="720p">720p HD</SelectItem>
                          <SelectItem value="480p">480p SD</SelectItem>
                          <SelectItem value="360p">360p SD</SelectItem>
                          <SelectItem value="240p">240p</SelectItem>
                          <SelectItem value="144p">144p</SelectItem>
                          <SelectItem value="audio">Audio Only (m4a)</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        data-testid="button-download-zip"
                        onClick={async () => {
                          try {
                            const zipUrl = await createPlaylistDownloadLink(submittedUrl, zipQuality);
                            triggerBrowserDownload(zipUrl);
                            toast({ title: "ZIP download started", description: `Packaging ${playlistInfo.videoCount} videos - this may take a while.` });
                          } catch (err) {
                            toast({
                              title: "ZIP download failed",
                              description: err instanceof Error ? err.message : "Could not create secure playlist download link.",
                              variant: "destructive",
                            });
                          }
                        }}
                        className="h-10 min-[460px]:h-9 gap-1.5 rounded-lg font-semibold text-xs shadow-sm shadow-primary/20 hover:shadow-primary/30 shrink-0 whitespace-nowrap w-full min-[460px]:w-auto"
                      >
                        <Package className="w-3.5 h-3.5" />
                        Download ZIP
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Video grid */}
              <div className="flex flex-col gap-2">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground px-1">
                  Click a video to see download options
                </p>
                {playlistInfo.videos.map((v, idx) => (
                  <PlaylistVideoRow key={v.videoId} video={v} index={idx + 1} onClick={() => openPlaylistVideo(v)} />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* SINGLE VIDEO VIEW (standalone or from playlist) */}
        <AnimatePresence>
          {videoInfo && !videoLoading && (
            <motion.div key="result" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: "easeOut" }} className="flex flex-col gap-6"
            >
              {/* Back to playlist button */}
              {singleVideoUrl && playlistInfo && (
                <button onClick={backToPlaylist} data-testid="button-back-playlist"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors self-start"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back to playlist
                </button>
              )}

              {/* Thumbnail */}
              <div className="relative w-full aspect-video rounded-2xl overflow-hidden border border-border/30 shadow-2xl bg-black group">
                <img src={videoInfo.thumbnailUrl} alt={videoInfo.title}
                  className="w-full h-full object-cover opacity-90 group-hover:opacity-100 group-hover:scale-[1.02] transition-all duration-500"
                  data-testid="img-thumbnail"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
                <div className="absolute bottom-3 right-3 flex items-center gap-1.5 bg-black/75 backdrop-blur-sm px-2.5 py-1 rounded-lg text-xs font-semibold text-white border border-white/10">
                  <Play className="w-3 h-3 fill-current" />
                  {formatDuration(videoInfo.durationSeconds)}
                </div>
              </div>

              {/* Title + Meta */}
              <div className="flex flex-col gap-2">
                <h2 className="text-xl font-bold leading-snug" data-testid="text-title">{videoInfo.title}</h2>
                <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    <Youtube className="w-4 h-4 text-primary" />{videoInfo.author}
                  </span>
                  {videoInfo.viewCount && (
                    <span className="flex items-center gap-1"><Eye className="w-3.5 h-3.5" />{formatViews(videoInfo.viewCount)} views</span>
                  )}
                  <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{formatDuration(videoInfo.durationSeconds)}</span>
                </div>
              </div>

              {/* Format filter */}
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                  <Filter className="w-3.5 h-3.5" /> Formats
                </h3>
                <button onClick={() => setBestOnly((v) => !v)} data-testid="button-best-only"
                  className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border transition-all ${
                    bestOnly
                      ? "bg-primary text-primary-foreground border-primary shadow-sm shadow-primary/30"
                      : "bg-card text-muted-foreground border-border/50 hover:border-primary/40 hover:text-foreground"
                  }`}
                >
                  <Star className="w-3 h-3" /> Best only
                </button>
              </div>

              {/* Format groups */}
              <div className="flex flex-col gap-5">
                {displayCombined.length > 0 && (
                  <FormatGroup label="Video + Audio" icon={<Video className="w-4 h-4" />}
                    formats={displayCombined}
                    onDownload={handleVideoDownload}
                  />
                )}
                {displayAudio.length > 0 && (
                  <FormatGroup label="Audio Only" icon={<Music className="w-4 h-4" />}
                    formats={displayAudio}
                    onDownload={handleVideoDownload}
                  />
                )}
                {displayVideo.length > 0 && (
                  <FormatGroup label="Video Only (no sound)" icon={<Video className="w-4 h-4 opacity-50" />}
                    formats={displayVideo}
                    onDownload={handleVideoDownload}
                  />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="w-full border-t border-border/30 bg-background/80 px-4 py-4">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-center">
          <a
            href={SMARTLINK_URL}
            target="_blank"
            rel="nofollow sponsored noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card px-4 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            Sponsored
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </footer>

      <AnimatePresence>
        {prepareDialog?.open && (
          <motion.div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              className="relative w-full max-w-sm rounded-2xl bg-card border border-border shadow-2xl p-5 text-center"
              initial={{ opacity: 0, y: 18, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
            >
              <button
                className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
                onClick={() => setPrepareDialog(null)}
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>

              {prepareDialog.status === "success" ? (
                <>
                  <h3 className="text-lg font-bold mb-4">Your video is ready for downloading!</h3>
                  <Button
                    size="lg"
                    className="rounded-xl font-bold px-8"
                    onClick={() => {
                      if (prepareDialog.downloadUrl) {
                        triggerBrowserDownload(prepareDialog.downloadUrl);
                        setPrepareDialog(null);
                      }
                    }}
                  >
                    <ArrowDownToLine className="w-4 h-4 mr-2" />
                    Download Now
                  </Button>
                </>
              ) : (
                <>
                  <h3 className="text-lg font-bold mb-2">Preparing your video - just a moment</h3>
                  <p className="text-sm text-muted-foreground mb-5">Please keep this page open until the download is ready.</p>
                </>
              )}

              <div className="mt-5 rounded-xl bg-secondary/60 p-3 text-left">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-semibold truncate">{prepareDialog.quality}</span>
                  <span className="text-xs uppercase text-muted-foreground">{prepareDialog.container}</span>
                </div>
                {prepareDialog.status !== "success" && (
                  <div className="mt-4 h-3 rounded-full bg-background overflow-hidden border border-border/60">
                    <div
  className="h-full bg-primary transition-all duration-500"
 style={{
  width: `${prepareDialog.progress === 0 ? 0 : Math.max(4, prepareDialog.progress)}%`,
}}
/>
                  </div>
                )}
                {prepareDialog.status === "running" && (
                  <p className="mt-2 text-xs text-muted-foreground">{prepareDialog.progress}% prepared</p>
                )}
                {prepareDialog.status === "error" && (
                  <p className="mt-3 text-sm text-destructive">{prepareDialog.error || "Could not prepare this download."}</p>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// playlist video row

function PlaylistVideoRow({ video, index, onClick }: { video: PlaylistVideo; index: number; onClick: () => void }) {
  return (
    <motion.button
      onClick={onClick}
      data-testid={`playlist-video-${video.videoId}`}
      className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border/40 hover:border-primary/40 hover:bg-accent/40 transition-all duration-200 group text-left w-full min-w-0"
      whileHover={{ x: 2 }}
      transition={{ duration: 0.15 }}
    >
      <span className="hidden min-[380px]:block text-xs text-muted-foreground font-mono w-6 shrink-0 text-right">{index}</span>
      <div className="relative w-16 h-10 min-[380px]:w-20 min-[380px]:h-12 rounded-lg overflow-hidden bg-secondary shrink-0">
        <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        {video.durationSeconds != null && (
          <div className="absolute bottom-0.5 right-0.5 bg-black/80 text-white text-[10px] font-semibold px-1 rounded">
            {formatDuration(video.durationSeconds)}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-snug line-clamp-2 group-hover:text-primary transition-colors">{video.title}</p>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">{video.author}</p>
      </div>
      <ArrowDownToLine className="hidden min-[380px]:block w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
    </motion.button>
  );
}

// format group

function FormatGroup({ label, icon, formats, onDownload }: {
  label: string; icon: React.ReactNode; formats: VideoFormat[];
  onDownload: (itag: string) => void | Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground px-1">
        {icon}{label}
      </div>
      <div className="grid gap-2">
        {formats.map((fmt) => (
          <FormatRow key={fmt.itag} format={fmt} size={formatSize(fmt.filesize)}
            onDownload={() => onDownload(fmt.itag)}
          />
        ))}
      </div>
    </div>
  );
}

// format row

function FormatRow({ format, size, onDownload }: {
  format: VideoFormat; size: string | null;
  onDownload: () => void;
}) {
  const prepared = isPreparedFormat(format);

  return (
    <div className="flex flex-col min-[460px]:flex-row min-[460px]:items-center min-[460px]:justify-between gap-3 px-4 py-3 rounded-xl bg-card border border-border/40 hover:border-primary/40 hover:bg-accent/40 transition-all duration-200 group"
      data-testid={`format-row-${format.itag}`}
    >
      <div className="flex items-center gap-3 min-w-0 w-full">
        <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center border border-border/50 group-hover:border-primary/30 group-hover:bg-primary/10 transition-colors shrink-0">
          {format.hasVideo ? <Video className="w-4 h-4 text-primary" /> : <Music className="w-4 h-4 text-primary" />}
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="font-semibold text-sm truncate">
            {format.qualityLabel}
            <span className="ml-2 text-xs font-mono text-muted-foreground bg-secondary px-1.5 py-0.5 rounded uppercase">{format.container}</span>
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {size && <span className="flex items-center gap-1"><HardDrive className="w-3 h-3" />{size}</span>}
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                prepared ? "bg-amber-500/15 text-amber-600 dark:text-amber-300" : "bg-green-500/15 text-green-600 dark:text-green-300"
              }`}
              title={prepared ? "This quality is prepared on the server, then downloaded as a normal MP4." : "This format can stream to your browser faster."}
            >
              {prepared ? "Prepared merge" : "Fast download"}
            </span>
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 w-full min-[460px]:w-auto">
        <Button size="sm" onClick={onDownload} data-testid={`button-download-${format.itag}`}
          className="gap-1.5 rounded-lg font-semibold text-xs shadow-sm shadow-primary/20 hover:shadow-primary/30 transition-all active:scale-[0.97] w-full min-[460px]:w-auto"
        >
          <ArrowDownToLine className="w-3.5 h-3.5" /> Download
        </Button>
      </div>
    </div>
  );
}
