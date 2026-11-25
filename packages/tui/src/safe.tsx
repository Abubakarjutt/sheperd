import { redact } from "@rewire/core";
import { Text, type TextProps } from "ink";
import { sanitize } from "./sanitize.js";

/**
 * The one render boundary for untrusted text (model, tool, skill, repo, error). Every component
 * that shows such text must use this instead of a bare `<Text>` with a string child. It
 * sanitizes and then redacts (I2), so no path to the terminal can skip either.
 */
export function Safe({ children, ...props }: TextProps & { children: string }) {
  return <Text {...props}>{redact(sanitize(children))}</Text>;
}
