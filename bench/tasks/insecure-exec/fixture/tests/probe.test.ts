import { afterEach, expect, test } from "vitest";
import { probeImage } from "../src/media/probe.js";
import { installFakeMagick } from "./fakeMagick.js";

let restore = () => {};
afterEach(() => restore());

test("probeImage parses identify output and passes the path as one argument", async () => {
  const fake = await installFakeMagick({ stdout: "640 480" });
  restore = fake.restore;
  await expect(probeImage("my photo; ls.png")).resolves.toEqual({ width: 640, height: 480 });
  const [call] = await fake.calls();
  expect(call?.at(-1)).toBe("my photo; ls.png");
});
