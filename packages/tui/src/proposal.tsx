import { Box, useInput } from "ink";
import { useRef } from "react";
import { fit } from "./fit.js";
import { Safe } from "./safe.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

/** The chat agent's `propose_run`: shows the task and asks once. `y` accepts, `n` dismisses. */
export function ProposalCard({
  task,
  onAnswer,
}: {
  task: string;
  onAnswer: (run: boolean) => void;
}) {
  const cols = useColumns();
  const done = useRef(false);
  useInput((input) => {
    if (done.current || (input !== "y" && input !== "n")) return;
    done.current = true;
    onAnswer(input === "y");
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.busy}>
      <Safe>{task}</Safe>
      <Safe wrap="truncate" color={theme.busy}>
        {fit("Run this as a gated task? [y/n]", Math.max(1, cols - 2))}
      </Safe>
    </Box>
  );
}

/** A run's clarification questions; the answers are typed into the input box, one per question. */
export function ClarifyPanel({ questions, index }: { questions: string[]; index: number }) {
  const cols = useColumns();
  return (
    <Box flexDirection="column">
      <Safe wrap="truncate" color={theme.busy}>
        {fit("The run needs answers before it can continue:", cols)}
      </Safe>
      {questions.map((q, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of one prompt
        <Safe key={i} color={i === index ? undefined : theme.dim}>
          {`${i + 1}. ${q}`}
        </Safe>
      ))}
      <Safe wrap="truncate" color={theme.dim}>
        {fit(
          `answer ${Math.min(index + 1, questions.length)}/${questions.length}, or /skip to decline`,
          cols,
        )}
      </Safe>
    </Box>
  );
}
