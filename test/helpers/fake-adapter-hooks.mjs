// Wrappers over runner/adapters/fake.ts that script one open or one send. Test-only.

/** The adapter with open() replaced by fn(options, ctx, baseOpen). */
export function wrapOpen(adapter, fn) {
  const baseOpen = adapter.open;
  return { ...adapter, open: (options, ctx) => fn(options, ctx, baseOpen) };
}

/** The adapter whose resumed handles reject every send with `error`; the base handle is never sent to. */
export function wrapSendError(adapter, error) {
  const baseResume = adapter.resume;
  return {
    ...adapter,
    resume: async (record, ctx, env) => ({ ...(await baseResume(record, ctx, env)), send: async () => { throw error; } }),
  };
}
