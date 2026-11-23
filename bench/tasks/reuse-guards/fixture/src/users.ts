import { ValidationError } from "./errors.js";
import { assertNonEmpty, isEmail } from "./validate/guards.js";

export type NewUser = { name: string; email: string };

export function registerUser(input: { name: string; email: string }): NewUser {
  const name = assertNonEmpty(input.name, "name");
  const email = input.email.trim().toLowerCase();
  if (!isEmail(email)) throw new ValidationError("email", "is not a valid email address");
  return { name, email };
}
