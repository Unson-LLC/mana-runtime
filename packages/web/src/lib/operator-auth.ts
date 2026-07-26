export const OPERATOR_TOKEN_STORAGE_KEY = "openryoko.operatorToken";
export const OPERATOR_AUTH_CHANGED_EVENT = "openryoko:operator-auth-changed";

export function operatorToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(OPERATOR_TOKEN_STORAGE_KEY) ?? undefined;
}

export function storeOperatorToken(value: string): void {
  if (typeof window === "undefined") return;
  if (value) window.localStorage.setItem(OPERATOR_TOKEN_STORAGE_KEY, value);
  else window.localStorage.removeItem(OPERATOR_TOKEN_STORAGE_KEY);
  window.dispatchEvent(new Event(OPERATOR_AUTH_CHANGED_EVENT));
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
