const configuredApiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").trim();

export const apiBaseUrl = configuredApiBaseUrl.replace(/\/+$/, "");

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (!apiBaseUrl) return path;

  return `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export function absoluteApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (apiBaseUrl) return apiUrl(path);

  return new URL(path, window.location.origin).toString();
}
