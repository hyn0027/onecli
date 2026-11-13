"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Switch } from "@onecli/ui/components/switch";
import { cedarPolicy } from "@/lib/api";
import { POLICY_QUERY_KEY } from "../../../settings/policy/_components/cedar-policies";

/**
 * Local addition: the workspace layer of credentials as this agent sees it:
 * every workspace-wide credential, with a switch for whether THIS agent uses it
 * (off = the agent is excluded from the share, and loses the grant).
 */
export const WorkspaceCredentialsCard = ({ agentId }: { agentId: string }) => {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: POLICY_QUERY_KEY,
    queryFn: cedarPolicy.get,
  });
  const toggle = useMutation({
    mutationFn: ({ id, excluded }: { id: string; excluded: string[] }) =>
      cedarPolicy.setSharedCredential(id, {
        shared: true,
        excludedAgentIds: excluded,
      }),
    onSuccess: () => {
      toast.success("Saved");
      void qc.invalidateQueries();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not save"),
  });
  const shared = (data?.secrets ?? []).filter((s) => s.workspaceShared);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">From the workspace</h2>
        <p className="text-muted-foreground text-sm">
          Workspace-wide credentials. Switch one off to stop this agent using
          it. Manage them on{" "}
          <Link
            className="underline"
            href={`/w/${workspaceId}/settings/credentials`}
          >
            Settings → Credentials
          </Link>
          .
        </p>
      </div>
      <div className="divide-y rounded-lg border">
        {shared.map((s) => {
          const on = !s.sharedExcludedAgentIds.includes(agentId);
          return (
            <label
              key={s.id}
              className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm"
            >
              <Switch
                checked={on}
                disabled={toggle.isPending}
                aria-label={`This agent uses ${s.name}`}
                onCheckedChange={(next) =>
                  toggle.mutate({
                    id: s.id,
                    excluded: next
                      ? s.sharedExcludedAgentIds.filter((id) => id !== agentId)
                      : [...s.sharedExcludedAgentIds, agentId],
                  })
                }
              />
              <span className="font-medium">{s.name}</span>
              <Badge variant="outline">{s.type}</Badge>
              <code className="text-muted-foreground ml-auto text-xs">
                {s.hostPattern}
              </code>
            </label>
          );
        })}
        {shared.length === 0 && (
          <p className="text-muted-foreground p-4 text-sm">
            No workspace-wide credentials.
          </p>
        )}
      </div>
    </div>
  );
};
