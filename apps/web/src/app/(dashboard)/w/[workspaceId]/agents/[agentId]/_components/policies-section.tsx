"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Switch } from "@onecli/ui/components/switch";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cedarPolicy } from "@/lib/api";
import { groupAgent } from "@/lib/cedar-scope";
import {
  activeCount,
  CedarPolicies,
  POLICY_QUERY_KEY,
} from "../../../settings/policy/_components/cedar-policies";

/**
 * Local addition: this agent's own Cedar policy groups — the groups whose every
 * policy names this agent as principal (see lib/cedar-scope.ts). Workspace-wide
 * groups live on Settings → Policy; they apply to this agent unless switched off
 * for it, which is the switch shown here for each.
 */
export const PoliciesSection = ({ agentId }: { agentId: string }) => {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: POLICY_QUERY_KEY,
    queryFn: cedarPolicy.get,
  });
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: ({ id, excluded }: { id: string; excluded: string[] }) =>
      cedarPolicy.updateGroup(id, { excludedAgentIds: excluded }),
    onSuccess: () => {
      toast.success("Saved: the gateway applies it within seconds");
      void qc.invalidateQueries({ queryKey: POLICY_QUERY_KEY });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !data) {
    return (
      <Card className="p-6 text-sm">
        Could not load the policy:{" "}
        {error instanceof Error ? error.message : "unknown error"}
      </Card>
    );
  }
  const agent = data.agents.find((a) => a.id === agentId) ?? null;
  if (!agent) {
    return (
      <Card className="p-6 text-sm">
        This agent is not in the policy listing.
      </Card>
    );
  }
  const own = data.groups.filter(
    (g) => groupAgent(g, data.agents)?.id === agent.id,
  );
  const universal = data.groups.filter((g) => !groupAgent(g, data.agents));

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Policies for this agent</h2>
        <p className="text-muted-foreground text-sm">
          Groups written for {agent.name} alone: every policy names it as
          principal, so they never open anything for another agent.{" "}
          {activeCount(own)} of {own.reduce((n, g) => n + g.policies.length, 0)}{" "}
          policies applied. New policies here start scoped to this agent.
        </p>
      </div>
      <CedarPolicies groups={own} agent={agent} />

      <div className="space-y-2">
        <h2 className="text-base font-semibold">From the workspace</h2>
        <p className="text-muted-foreground text-sm">
          Workspace-wide groups. Switch one off to stop it applying to this
          agent. Edit them on{" "}
          <Link
            className="underline"
            href={`/w/${workspaceId}/settings/policy`}
          >
            Settings → Policy
          </Link>
          .
        </p>
        <div className="divide-y rounded-lg border">
          {universal.map((g) => (
            <label
              key={g.id}
              className={`flex cursor-pointer items-center gap-3 px-4 py-2 text-sm ${g.enabled ? "" : "opacity-60"}`}
            >
              <Switch
                checked={!g.excludedAgentIds.includes(agent.id)}
                disabled={toggle.isPending}
                aria-label={`${agent.name} uses ${g.name}`}
                onCheckedChange={(next) =>
                  toggle.mutate({
                    id: g.id,
                    excluded: next
                      ? g.excludedAgentIds.filter((id) => id !== agent.id)
                      : [...g.excludedAgentIds, agent.id],
                  })
                }
              />
              <span className="font-medium">{g.name}</span>
              {g.source && <Badge variant="outline">{g.source}</Badge>}
              <span className="text-muted-foreground ml-auto tabular-nums">
                {g.enabled
                  ? `group on · ${g.policies.filter((p) => p.enabled).length} of ${g.policies.length}`
                  : "group off"}
              </span>
            </label>
          ))}
          {universal.length === 0 && (
            <p className="text-muted-foreground p-4 text-sm">None.</p>
          )}
        </div>
      </div>
    </div>
  );
};
