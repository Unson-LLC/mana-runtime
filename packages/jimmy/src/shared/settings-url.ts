export function safeSettingsBaseUrl(webBaseUrl: string | undefined): URL | null {
  if (!webBaseUrl?.trim()) return null;
  try {
    const url = new URL(webBaseUrl);
    if (url.username || url.password) return null;
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) return null;
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}
