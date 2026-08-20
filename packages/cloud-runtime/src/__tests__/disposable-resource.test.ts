import { describe, expect, it, vi } from "vitest";

import { withDisposableResource } from "../disposable-resource.js";

describe("withDisposableResource", () => {
  it("keeps the resource alive until the asynchronous operation settles", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const dispose = vi.fn();
    const resource = { [Symbol.dispose]: dispose };

    const pending = withDisposableResource(
      async () => resource,
      async () => {
        await gate;
        expect(dispose).not.toHaveBeenCalled();
        return "done";
      },
    );

    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
    finish();

    await expect(pending).resolves.toBe("done");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes the resource after an asynchronous failure", async () => {
    const dispose = vi.fn();
    const resource = { [Symbol.dispose]: dispose };

    await expect(withDisposableResource(
      async () => resource,
      async () => {
        await Promise.resolve();
        throw new Error("operation failed");
      },
    )).rejects.toThrow("operation failed");

    expect(dispose).toHaveBeenCalledOnce();
  });
});
