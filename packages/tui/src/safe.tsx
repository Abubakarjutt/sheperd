import { Text, type TextProps } from "ink";
import { sanitize } from "./sanitize.js";

/**
 * The one render boundary for untrusted text (model, tool, skill, repo, error). Every component
 * that shows such text must use this instead of a bare `<Text>` with a string child.
 */
export function Safe({ children, ...props }: TextProps & { children: string }) {
  return <Text {...props}>{sanitize(children)}</Text>;
}
