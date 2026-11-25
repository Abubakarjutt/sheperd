import { EventEmitter } from "node:events";
import type { ChatSession, RunController } from "@rewire/session";
import { describe, expect, it } from "vitest";
import { renderTui } from "../src/index.js";

function streams() {
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 24,
    isTTY: false,
    write: () => true,
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => {},
    ref: () => {},
    unref: () => {},
    resume: () => stdin,
    pause: () => stdin,
    read: () => null,
  });
  return { stdout, stdin } as never as { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream };
}

const deps = (history: () => unknown[]) => ({
  session: { history, send: async () => ({ text: "" }) } as unknown as ChatSession,
  runController: {} as RunController,
  config: {},
});

describe("renderTui", () => {
  it("resolves the exit code given to exit()", async () => {
    let exit: (c: number) => void = () => {};
    const p = renderTui({
      ...deps(() => []),
      renderOptions: { ...streams(), patchConsole: false },
      bindExit: (e) => {
        exit = e;
      },
    });
    exit(130);
    expect(await p).toBe(130);
  });

  it("rejects with tui_render_failed when rendering throws (M2), like the trust prompt", async () => {
    await expect(
      renderTui({
        ...deps(() => {
          throw new Error("render boom");
        }),
        renderOptions: { ...streams(), patchConsole: false },
      }),
    ).rejects.toMatchObject({
      code: "tui_render_failed",
      message: expect.stringContaining("render boom"),
    });
  });
});
