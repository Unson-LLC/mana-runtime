import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeOperatorWebSocketProtocols,
  operatorTokenFromWebSocketProtocol,
  verifyOperatorToken,
  webSocketOperatorAuthorized,
  webSocketUpgradeAuthorized,
} from "../operator-auth.js";

describe("operator authorization", () => {
  afterEach(() => delete process.env.OPENRYOKO_OPERATOR_TOKEN_SHA256);

  it("accepts only the configured operator token", () => {
    process.env.OPENRYOKO_OPERATOR_TOKEN_SHA256 = crypto.createHash("sha256").update("correct").digest("hex");
    expect(verifyOperatorToken("correct")).toBe(true);
    expect(verifyOperatorToken("wrong")).toBe(false);
    expect(verifyOperatorToken(undefined)).toBe(false);
  });

  it("carries the operator token in WebSocket subprotocol metadata without putting it in the URL", () => {
    const token = "operator secret with unicode 秘";
    process.env.OPENRYOKO_OPERATOR_TOKEN_SHA256 = crypto.createHash("sha256").update(token).digest("hex");
    const protocols = encodeOperatorWebSocketProtocols(token);
    const header = protocols.join(", ");
    expect(operatorTokenFromWebSocketProtocol(header)).toBe(token);
    expect(webSocketOperatorAuthorized(header)).toBe(true);
    expect(webSocketOperatorAuthorized("openryoko-operator, openryoko-token.d3Jvbmc")).toBe(false);
    expect(webSocketOperatorAuthorized(undefined)).toBe(false);
    expect(webSocketUpgradeAuthorized(true, header)).toBe(true);
    expect(webSocketUpgradeAuthorized(true, undefined)).toBe(false);
    expect(webSocketUpgradeAuthorized(false, undefined)).toBe(true);
  });
});
