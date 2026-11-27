import { Box } from "ink";
import { type ReactNode, useState } from "react";
import { fit } from "./fit.js";
import { ListPicker, type ListPickerItem } from "./list-picker.js";
import {
  ROUTING_ROLES,
  type RoutingControlDep,
  type RoutingModel,
  type RoutingRole,
  type RoutingSource,
} from "./routing.js";
import { Safe } from "./safe.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

/** How each role is named in the picker: `spec` is also the chat model. */
export const ROLE_LABEL: Readonly<Record<RoutingRole, string>> = {
  spec: "chat & spec",
  "test-writer": "test-writer",
  implementer: "implementer",
  reviewer: "reviewer",
  verifier: "verifier",
};

/** Where a role's model comes from, as the picker shows it. */
export const SOURCE_LABEL: Readonly<Record<RoutingSource, string>> = {
  session: "session",
  file: "models.toml",
  auto: "auto",
};

export const PICK_ROLE = "Choose a role";
export const APPLYING = "applying…";
const DEFAULT_DETAIL = "drop the session pick: models.toml or automatic routing";

const refText = (r: RoutingModel): string => `${r.provider}:${r.model}`;
const same = (a: RoutingModel, b: RoutingModel): boolean =>
  a.provider === b.provider && a.model === b.model;

export type ModelPickerProps = {
  control: RoutingControlDep;
  /** Enter on a model (or `default`, as undefined) in step 2. */
  onPick: (role: RoutingRole, ref: RoutingModel | undefined) => void;
  /** Esc in step 1. */
  onClose: () => void;
  /** A pick is being applied: keys are ignored and the picker says so. */
  applying?: boolean;
  /** Keys are taken only while true (default true). */
  isActive?: boolean;
};

/**
 * `/model`: step 1 lists the roles with their current `provider:model`, family and source; Enter
 * opens step 2, the available models with their family and a `default` row, the current one
 * marked and selected. Enter there picks; Esc goes back to step 1, and Esc in step 1 closes.
 */
export function ModelPicker({
  control,
  onPick,
  onClose,
  applying = false,
  isActive = true,
}: ModelPickerProps) {
  const cols = useColumns();
  const [roleIndex, setRoleIndex] = useState(0);
  const [role, setRole] = useState<RoutingRole | undefined>(undefined);
  const [modelIndex, setModelIndex] = useState(0);
  const routing = control.current();
  const available = control.available();
  const active = isActive && !applying;

  let body: ReactNode;
  if (role === undefined) {
    const items: ListPickerItem[] = ROUTING_ROLES.map((r) => ({
      label: ROLE_LABEL[r],
      detail: `${refText(routing[r])} · ${control.family(routing[r])} · ${SOURCE_LABEL[control.source(r)]}`,
    }));
    body = (
      <ListPicker
        title={PICK_ROLE}
        items={items}
        selected={roleIndex}
        onMove={setRoleIndex}
        onSelect={(i) => {
          const r = ROUTING_ROLES[i] as RoutingRole;
          const at = available.findIndex((m) => same(m, routing[r]));
          setModelIndex(at < 0 ? 0 : at + 1);
          setRole(r);
        }}
        onCancel={onClose}
        footer="↑/↓ move · Enter choose · Esc close"
        isActive={active}
      />
    );
  } else {
    const now = routing[role];
    const items: ListPickerItem[] = [
      { label: "default", detail: DEFAULT_DETAIL },
      ...available.map((m) => ({
        label: refText(m),
        detail: `${control.family(m)}${same(m, now) ? " · current" : ""}`,
      })),
    ];
    body = (
      <ListPicker
        title={`Model for ${ROLE_LABEL[role]}`}
        items={items}
        selected={modelIndex}
        onMove={setModelIndex}
        onSelect={(i) => onPick(role, i === 0 ? undefined : available[i - 1])}
        onCancel={() => setRole(undefined)}
        footer="↑/↓ move · Enter pick · Esc back"
        isActive={active}
      />
    );
  }
  return (
    <Box flexDirection="column">
      {body}
      {applying ? (
        <Box paddingX={1}>
          <Safe wrap="truncate" color={theme.busy}>
            {fit(APPLYING, Math.max(1, cols - 2))}
          </Safe>
        </Box>
      ) : null}
    </Box>
  );
}
