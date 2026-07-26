export const OPERATOR_TOKEN_STORAGE_KEY = "openryoko.operatorToken";

export function operatorToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(OPERATOR_TOKEN_STORAGE_KEY) ?? undefined;
}

export function operatorWebSocketProtocols(): string[] | undefined {
  const token = operatorToken();
  if (!token) return undefined;
  const bytes = new TextEncoder().encode(token);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return ["openryoko-operator", `openryoko-token.${encoded}`];
}
