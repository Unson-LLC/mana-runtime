import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CONTRACT_LEDGER_HEADERS, createJwtAssertion, DOCUSIGN_TOOLS, envelopeToContractLedgerRow, requireNonEmptyString } from "../docusign-server.js";

describe("docusign-server", () => {
  it("exposes the read surface needed to build the contract ledger", () => {
    expect(DOCUSIGN_TOOLS.map((tool) => tool.name)).toEqual(["auth_status", "list_envelopes", "list_contract_ledger_rows", "get_envelope", "list_recipients", "list_documents"]);
  });
  it("creates an RS256 JWT assertion with the required DocuSign claims", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const assertion = createJwtAssertion("integration-key", "api-user-id", "account.docusign.com", privateKey.export({ type: "pkcs8", format: "pem" }).toString(), 1_700_000_000);
    const [header, payload, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iss: "integration-key", sub: "api-user-id", aud: "account.docusign.com", iat: 1_700_000_000, exp: 1_700_003_600, scope: "signature impersonation" });
    expect(signature.length).toBeGreaterThan(100);
  });
  it("rejects missing identifiers", () => {
    expect(requireNonEmptyString("  envelope-id  ", "envelopeId")).toBe("envelope-id");
    expect(() => requireNonEmptyString(" ", "envelopeId")).toThrow("envelopeId must be a non-empty string");
  });
  it("maps DocuSign envelopes onto the existing contract-ledger columns", () => {
    const row = envelopeToContractLedgerRow({ envelopeId: "abc-123", emailSubject: "業務委託契約", status: "completed", completedDateTime: "2026-08-01T01:02:03Z", sender: { userName: "佐藤" }, recipients: { signers: [{ name: "株式会社サンプル" }, { email: "legal@example.com" }] } });
    expect(row).toHaveLength(CONTRACT_LEDGER_HEADERS.length);
    expect(row[0]).toBe("abc-123");
    expect(row[1]).toBe("業務委託契約");
    expect(row[3]).toBe("株式会社サンプル、legal@example.com");
    expect(row[6]).toBe("completed");
    expect(row[7]).toBe("2026-08-01T01:02:03Z");
    expect(row[15]).toContain("abc-123");
    expect(row[16]).toBe("DocuSign");
  });
});
