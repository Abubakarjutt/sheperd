import { RunEvent, redact } from "@rewire/core";

/**
 * One JSONL line for an event, or undefined if it is not a valid RunEvent. The orchestrator
 * already redacts what it hands the observer; this redacts the serialized line once more and
 * re-validates it, so stdout can only ever carry schema-valid events.
 */
export function headlessLine(e: unknown): string | undefined {
  try {
    const line = redact(JSON.stringify(e));
    if (!RunEvent.safeParse(JSON.parse(line)).success) return undefined;
    return `${line}\n`;
  } catch {
    return undefined;
  }
}
