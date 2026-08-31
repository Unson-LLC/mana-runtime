import {
  TaskBoardBinding,
  completeTaskBoardBinding,
  reserveTaskBoardBinding,
} from "../task-board-binding.js";

function bindingHarness() {
  const values = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    delete: vi.fn(async (key: string) => values.delete(key)),
    transaction: vi.fn(async (closure: (tx: unknown) => Promise<unknown>) => closure(storage)),
  };
  const object = new TaskBoardBinding({ storage } as never);
  const stub = { fetch: (request: Request) => object.fetch(request) };
  const namespace = { idFromName: vi.fn((name: string) => name), get: vi.fn(() => stub) };
  return { namespace, values };
}

const coordinates = {
  tenantId: "unson-business",
  targetId: "minutes-pms",
  workspaceId: "T07A9J3PEMB",
  channelId: "C0BKX9Y169F",
  bindingRevision: 1,
};

describe("task board runtime binding", () => {
  it("story-task-canvas-ownership:ac:2 reuses only the Canvas ID completed by Mana", async () => {
    const { namespace } = bindingHarness();
    expect(await reserveTaskBoardBinding(namespace, coordinates)).toEqual({ status: "reserved" });
    await completeTaskBoardBinding(namespace, coordinates, "FMANA1");
    expect(await reserveTaskBoardBinding(namespace, coordinates)).toEqual({
      status: "bound",
      canvasId: "FMANA1",
    });
  });

  it("story-task-canvas-ownership:ac:3 serializes provisioning and preserves an uncertain reservation", async () => {
    const { namespace } = bindingHarness();
    expect(await reserveTaskBoardBinding(namespace, coordinates)).toEqual({ status: "reserved" });
    expect(await reserveTaskBoardBinding(namespace, coordinates)).toEqual({ status: "provisioning" });
  });

  it("accepts the canonical opaque tenant ID returned by Brainbase", async () => {
    const { namespace } = bindingHarness();
    expect(await reserveTaskBoardBinding(namespace, {
      ...coordinates,
      tenantId: "ten_01M0HMA228ES64N4TFX846V8T8",
    })).toEqual({ status: "reserved" });
  });
});
