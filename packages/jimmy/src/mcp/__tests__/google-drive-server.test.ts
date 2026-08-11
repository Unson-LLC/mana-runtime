import { describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createInlineDriveFile,
  decodeInlineFileContent,
  GOOGLE_DRIVE_TOOLS,
  isDirectExecution,
  MAX_INLINE_UPLOAD_BYTES,
  normalizeSheetValues,
  requireNonEmptyString,
} from "../google-drive-server.js";

describe("google-drive-server", () => {
  it("recognizes direct execution through a symbolic link", async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), "mana-drive-entry-"));
    const modulePath = path.join(fixtureDir, "google-drive-server.js");
    const symlinkPath = path.join(fixtureDir, "stable-google-drive-server.js");

    try {
      await writeFile(modulePath, "");
      await symlink(modulePath, symlinkPath);

      expect(isDirectExecution(symlinkPath, pathToFileURL(modulePath).href)).toBe(true);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("exposes Drive artifact and Google Sheets write tools", () => {
    expect(GOOGLE_DRIVE_TOOLS.map((tool) => tool.name)).toEqual([
      "auth_status",
      "list_files",
      "get_file",
      "create_folder",
      "create_file",
      "upload_file",
      "create_spreadsheet",
      "write_sheet_values",
      "get_sheet_values",
    ]);
  });

  it("accepts Sheets scalar values and preserves row structure", () => {
    expect(normalizeSheetValues([
      ["契約名", "金額", "有効"],
      ["業務委託契約", 100000, true],
      ["空欄", null, false],
    ])).toEqual([
      ["契約名", "金額", "有効"],
      ["業務委託契約", 100000, true],
      ["空欄", null, false],
    ]);
  });

  it("rejects malformed Sheets values", () => {
    expect(() => normalizeSheetValues([])).toThrow("non-empty two-dimensional array");
    expect(() => normalizeSheetValues(["not-a-row"])).toThrow("values[0] must be an array");
    expect(() => normalizeSheetValues([[{ formula: "=IMPORTXML(...)" }]])).toThrow("unsupported type");
  });

  it("requires identifiers and titles to be non-empty strings", () => {
    expect(requireNonEmptyString("  sheet-id  ", "spreadsheetId")).toBe("sheet-id");
    expect(() => requireNonEmptyString("   ", "spreadsheetId")).toThrow("spreadsheetId must be a non-empty string");
  });

  it("accepts exactly one inline content representation and applies safe MIME defaults", () => {
    expect(decodeInlineFileContent({ content: "Drive書き込みE2E成功" })).toEqual({
      bytes: Buffer.from("Drive書き込みE2E成功"),
      mimeType: "text/plain; charset=utf-8",
    });
    expect(decodeInlineFileContent({ contentBase64: Buffer.from([0, 1, 2]).toString("base64") })).toEqual({
      bytes: Buffer.from([0, 1, 2]),
      mimeType: "application/octet-stream",
    });
    expect(decodeInlineFileContent({ content: "csv", mimeType: "text/csv" }).mimeType).toBe("text/csv");
  });

  it("rejects ambiguous, malformed, empty, and oversized inline content", () => {
    expect(() => decodeInlineFileContent({})).toThrow("exactly one of content or contentBase64");
    expect(() => decodeInlineFileContent({ content: "x", contentBase64: "eA==" })).toThrow("exactly one");
    expect(() => decodeInlineFileContent({ content: "" })).toThrow("must not be empty");
    expect(() => decodeInlineFileContent({ contentBase64: "not base64!" })).toThrow("valid base64");
    expect(() => decodeInlineFileContent({ content: "x".repeat(MAX_INLINE_UPLOAD_BYTES + 1) })).toThrow("20 MiB");
  });

  it("uploads inline bytes with Drive metadata and removes its private temporary file", async () => {
    let observedUpload: Buffer | undefined;
    let observedArgs: string[] | undefined;
    let observedCwd: string | undefined;
    const result = await createInlineDriveFile({
      name: "mana-drive-write-e2e.txt",
      content: "Drive書き込みE2E成功",
      parentId: "folder-1",
    }, async (args, cwd) => {
      observedArgs = args;
      observedCwd = cwd;
      observedUpload = await import("node:fs/promises").then(({ readFile }) => readFile(`${cwd}/artifact`));
      return { id: "file-1", webViewLink: "https://drive.google.com/file/d/file-1/view" };
    });

    expect(result).toEqual({ id: "file-1", webViewLink: "https://drive.google.com/file/d/file-1/view" });
    expect(observedUpload).toEqual(Buffer.from("Drive書き込みE2E成功"));
    expect(observedArgs).toContain("--upload");
    expect(observedArgs).toContain("artifact");
    expect(observedArgs?.join(" ")).toContain("mana-drive-write-e2e.txt");
    expect(observedArgs?.join(" ")).toContain("folder-1");
    await expect(import("node:fs/promises").then(({ stat }) => stat(observedCwd!))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes its private temporary file when the Drive upload fails", async () => {
    let observedCwd: string | undefined;
    await expect(createInlineDriveFile({
      name: "failed.txt",
      content: "cleanup",
    }, async (_args, cwd) => {
      observedCwd = cwd;
      throw new Error("Drive upload failed");
    })).rejects.toThrow("Drive upload failed");

    await expect(import("node:fs/promises").then(({ stat }) => stat(observedCwd!))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
