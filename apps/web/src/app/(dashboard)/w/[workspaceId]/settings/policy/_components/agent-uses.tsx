"use client";

import { Switch } from "@onecli/ui/components/switch";
import type { AgentRef } from "@/lib/api/cedar-policy";

/**
 * Local addition: which agents use a workspace-wide item (a credential or a
 * policy group). Workspace-wide means every agent by default; switching an agent
 * off records it as excluded. Agents created later are in.
 */
export const usesSummary = (agents: AgentRef[], excluded: string[]) => {
  const n = agents.filter((a) => !excluded.includes(a.id)).length;
  return `${n} of ${agents.length} agents`;
};

export const AgentUses = ({
  agents,
  excluded,
  onChange,
  disabled = false,
}: {
  agents: AgentRef[];
  excluded: string[];
  onChange: (excluded: string[]) => void;
  disabled?: boolean;
}) => (
  <div className="flex flex-col gap-2">
    <p className="text-muted-foreground text-xs">
      Used by {usesSummary(agents, excluded)}. Agents created later use it too,
      until you switch them off here.
    </p>
    <div className="divide-y rounded-md border">
      {agents.map((a) => {
        const on = !excluded.includes(a.id);
        return (
          <label
            key={a.id}
            className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm"
          >
            <Switch
              checked={on}
              disabled={disabled}
              onCheckedChange={(next) =>
                onChange(
                  next
                    ? excluded.filter((id) => id !== a.id)
                    : [...excluded, a.id],
                )
              }
              aria-label={`${a.name} uses it`}
            />
            <span className="font-medium">{a.name}</span>
            <span className="text-muted-foreground font-mono text-xs">
              {a.identifier}
            </span>
          </label>
        );
      })}
      {agents.length === 0 && (
        <p className="text-muted-foreground p-3 text-sm">No agents yet.</p>
      )}
    </div>
  </div>
);
