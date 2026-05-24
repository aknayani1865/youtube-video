import crypto from "node:crypto";

const TOKEN_TTL_MS = 10 * 60 * 1000;

export interface VideoDownloadTokenPayload {
  url: string;
  itag: string;
  title: string;
  directUrl?: string;
  createdAt: number;
  expiresAt: number;
}

export interface PlaylistDownloadTokenPayload {
  url: string;
  quality: string;
  createdAt: number;
  expiresAt: number;
}

const videoTokens = new Map<string, VideoDownloadTokenPayload>();
const playlistTokens = new Map<string, PlaylistDownloadTokenPayload>();

function cleanupExpiredTokens() {
  const now = Date.now();
  for (const [token, payload] of videoTokens) {
    if (payload.expiresAt <= now) videoTokens.delete(token);
  }
  for (const [token, payload] of playlistTokens) {
    if (payload.expiresAt <= now) playlistTokens.delete(token);
  }
}

export function createVideoDownloadToken(input: {
  url: string;
  itag: string;
  title: string;
  directUrl?: string;
}): string {
  cleanupExpiredTokens();

  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  videoTokens.set(token, {
    url: input.url,
    itag: input.itag,
    title: input.title,
    directUrl: input.directUrl,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  });

  return token;
}

export function consumeVideoDownloadToken(token: string): VideoDownloadTokenPayload | null {
  cleanupExpiredTokens();

  const payload = videoTokens.get(token);
  if (!payload) return null;

  videoTokens.delete(token);
  if (payload.expiresAt <= Date.now()) return null;

  return payload;
}

export function createPlaylistDownloadToken(input: {
  url: string;
  quality: string;
}): string {
  cleanupExpiredTokens();

  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  playlistTokens.set(token, {
    url: input.url,
    quality: input.quality,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  });

  return token;
}

export function consumePlaylistDownloadToken(token: string): PlaylistDownloadTokenPayload | null {
  cleanupExpiredTokens();

  const payload = playlistTokens.get(token);
  if (!payload) return null;

  playlistTokens.delete(token);
  if (payload.expiresAt <= Date.now()) return null;

  return payload;
}
