import { describe, expect, test } from "vitest";
import { ValidationError } from "../src/errors.js";
import { createInvite } from "../src/invites.js";

const fieldOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof ValidationError ? e.field : `other:${String(e)}`;
  }
  return undefined;
};

describe("createInvite", () => {
  test("normalizes a valid invite", () => {
    expect(createInvite({ email: "  Bob@Example.COM ", seats: " 5 " })).toEqual({
      email: "bob@example.com",
      seats: 5,
      note: "",
    });
  });

  test("keeps the note", () => {
    expect(createInvite({ email: "a@b.io", seats: "1", note: "hi" }).note).toBe("hi");
  });

  test("seat bounds are inclusive", () => {
    expect(createInvite({ email: "a@b.io", seats: "1" }).seats).toBe(1);
    expect(createInvite({ email: "a@b.io", seats: "50" }).seats).toBe(50);
    expect(fieldOf(() => createInvite({ email: "a@b.io", seats: "0" }))).toBe("seats");
    expect(fieldOf(() => createInvite({ email: "a@b.io", seats: "51" }))).toBe("seats");
  });

  test("seats must be a whole number", () => {
    for (const bad of ["12abc", "1.5", "", "  ", "ten", "1e2"]) {
      expect(fieldOf(() => createInvite({ email: "a@b.io", seats: bad }))).toBe("seats");
    }
  });

  test("email must be valid", () => {
    for (const bad of ["a@b", "a b@c.io", "no-at.io", "", "a@@b.io"]) {
      expect(fieldOf(() => createInvite({ email: bad, seats: "2" }))).toBe("email");
    }
  });

  test("overlong emails are rejected", () => {
    const long = `${"a".repeat(250)}@b.io`;
    expect(fieldOf(() => createInvite({ email: long, seats: "2" }))).toBe("email");
  });

  test("note is limited to 200 characters", () => {
    expect(createInvite({ email: "a@b.io", seats: "2", note: "x".repeat(200) }).note).toHaveLength(200);
    expect(fieldOf(() => createInvite({ email: "a@b.io", seats: "2", note: "x".repeat(201) }))).toBe(
      "note",
    );
  });
});
