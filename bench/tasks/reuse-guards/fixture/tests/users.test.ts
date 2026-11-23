import { expect, test } from "vitest";
import { registerUser } from "../src/users.js";

test("registerUser normalizes the email", () => {
  expect(registerUser({ name: " Ann ", email: " Ann@Example.com " })).toEqual({
    name: "Ann",
    email: "ann@example.com",
  });
});
