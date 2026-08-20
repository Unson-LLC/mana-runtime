export interface DisposableResource {
  [Symbol.dispose](): void;
}

export async function withDisposableResource<Resource extends DisposableResource, Result>(
  acquire: () => Promise<Resource>,
  use: (resource: Resource) => Promise<Result>,
): Promise<Result> {
  using resource = await acquire();
  // Await inside the using scope so RPC-backed resources remain alive until use settles.
  return await use(resource);
}
