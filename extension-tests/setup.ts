import { vi } from "vitest";

// One pinned clock, so a date that was true when a test was written stays true.
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));

// No test reaches the network: a test that needs fetch stubs its own.
vi.stubGlobal("fetch", async (input: unknown) => {
  throw new Error(`A test reached the network without stubbing fetch: ${String(input)}`);
});
