import { describe, expect, it } from "vitest";
import {
  GOOGLE_DRIVE_TOOLS,
  normalizeSheetValues,
  requireNonEmptyString,
} from "../google-drive-server.js";

describe("google-drive-server", () => {
  it("exposes Drive artifact and Google Sheets write tools", () => {
    expect(GOOGLE_DRIVE_TOOLS.map((tool) => tool.name)).toEqual([
      "auth_status",
      "list_files",
      "get_file",
      "create_folder",
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
});
