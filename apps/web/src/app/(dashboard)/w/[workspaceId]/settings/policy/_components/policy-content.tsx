"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@onecli/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cedarPolicy } from "@/lib/api";
import type { CedarPolicyState } from "@/lib/api/cedar-policy";
import { groupAgent } from "@/lib/cedar-scope";
import { activeCount, CedarPolicies, POLICY_QUERY_KEY } from "./cedar-policies";

/** The default posture in words. Cedar decides every request in this build;
 *  the gateway status confirms it is the one actually running. */
const posture = (state: CedarPolicyState) => {
  const gw = state.gateway;
  if (!gw) {
    return {
      engine: "Unknown (gateway did not answer)",
      defaultLine: "Unknown",
      detail: "",
    };
  }
  if (gw.engine !== "cedar") {
    return {
      engine: "Rule engine (this gateway build does not run Cedar)",
      defaultLine: "Unknown",
      detail: "The Cedar policies below are not enforced by this gateway.",
    };
  }
  const universal = state.groups.filter((g) => !groupAgent(g, state.agents));
  const total = universal.reduce((n, g) => n + g.policies.length, 0);
  const groupsOn = universal.filter((g) => g.enabled).length;
  return {
    engine: `Cedar policies (${activeCount(universal)} of ${total} workspace-wide policies applied; ${groupsOn} of ${universal.length} groups on)`,
    defaultLine: "Block",
    detail:
      "A request passes only if an enabled permit policy matches and no enabled forbid policy does: credentialed or not, LLM hosts included.",
  };
};

export const PolicyContent = () => {
  const { data, isLoading, error } = useQuery({
    queryKey: POLICY_QUERY_KEY,
    queryFn: cedarPolicy.get,
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
  const p = posture(data);
  const universal = data.groups.filter((g) => !groupAgent(g, data.agents));
  const perAgent = data.groups.length - universal.length;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Enforcement</CardTitle>
          <CardDescription>
            How the gateway decides each request.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <div className="flex gap-2">
            <span className="text-muted-foreground w-36 shrink-0">
              Decided by
            </span>
            <span>{p.engine}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-36 shrink-0">
              By default
            </span>
            <span>
              <Badge
                variant={
                  p.defaultLine === "Block" ? "destructive" : "secondary"
                }
              >
                {p.defaultLine}
              </Badge>{" "}
              {p.detail}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cedar policies</CardTitle>
          <CardDescription>
            Workspace-wide policies: one Cedar statement per policy, organized
            in groups, used by every agent unless switched off for it (open a
            group, then Used by). Switch groups or single policies on or off,
            edit them, or add new ones; a policy applies only when it and its
            group are both on. Changes apply within seconds.
            {perAgent > 0 &&
              ` ${perAgent} more ${perAgent === 1 ? "group belongs" : "groups belong"} to single agents and ${perAgent === 1 ? "is" : "are"} on ${perAgent === 1 ? "its agent's" : "each agent's"} page (Policies).`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CedarPolicies groups={universal} agents={data.agents} />
        </CardContent>
      </Card>
    </div>
  );
};
