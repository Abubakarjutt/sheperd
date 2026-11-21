// Hashing and verification live in @rewire/gates (one implementation, hardened there).

export type { FrozenTestManifest } from "@rewire/core";
export { type FrozenMismatch, hashFiles, verifyFrozen } from "@rewire/gates";
