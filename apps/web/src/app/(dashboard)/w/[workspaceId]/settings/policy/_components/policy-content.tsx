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
import type { CedarPolicyState, PublishedRule } from "@/lib/api/cedar-policy";
import { activeCount, CedarPolicies, POLICY_QUERY_KEY } from "./cedar-policies";
import { GrantDetails } from "./grant-details";

/** The default posture in words. Cedar decides every request in this build;
 *  the gateway status confirms it is the one actually running. */
const posture = (state: CedarPolicyState) => {
  const gw = state.gateway;
  if (!gw) {
    return { engine: "Unknown (gateway did not answer)", defaultLine: "Unknown", detail: "" };
  }
  if (gw.engine !== "cedar") {
    return {
      engine: "Rule engine (this gateway build does not run Cedar)",
      defaultLine: "Unknown",
      detail: "The Cedar policies below are not enforced by this gateway.",
    };
  }
  const total = state.groups.reduce((n, g) => n + g.policies.length, 0);
  const groupsOn = state.groups.filter((g) => g.enabled).length;
  return {
    engine: `Cedar policies (${activeCount(state.groups)} of ${total} applied; ${groupsOn} of ${state.groups.length} groups on)`,
    defaultLine: "Block",
    detail:
      "A request passes only if an enabled permit policy matches and no enabled forbid policy does — credentialed or not, LLM hosts included.",
  };
};

/** Rules that grant credentials: allow rules aimed at a secret, an app, or a
 *  connection. Only these still matter; Cedar decides allow/deny. */
const isGrant = (r: PublishedRule) =>
  !r.isDefault &&
  r.action === "allow" &&
  r.targets.some((t) => t.kind === "secret" || t.kind === "app" || t.kind === "connection");

export const PolicyContent = () => {
  const { data, isLoading, error } = useQuery({
    queryKey: POLICY_QUERY_KEY,
    queryFn: cedarPolicy.get,
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !data) {
    return (
      <Card className="p-6 text-sm">
        Could not load the policy: {error instanceof Error ? error.message : "unknown error"}
      </Card>
    );
  }
  const p = posture(data);
  const grants = data.rules.rules.filter(isGrant);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Enforcement</CardTitle>
          <CardDescription>How the gateway decides each request.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <div className="flex gap-2">
            <span className="text-muted-foreground w-36 shrink-0">Decided by</span>
            <span>{p.engine}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-36 shrink-0">By default</span>
            <span>
              <Badge variant={p.defaultLine === "Block" ? "destructive" : "secondary"}>
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
            One Cedar statement per policy, organized in groups. Switch groups or single policies
            on or off, edit them, or add new ones; a policy applies only when it and its group are
            both on. Changes apply within seconds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CedarPolicies groups={data.groups} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Credential grants</CardTitle>
          <CardDescription>
            Which stored secrets and app connections the gateway injects for which agents. Grants
            never allow a request on their own — a Cedar policy still has to permit it. Manage grants
            on each agent&apos;s page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {grants.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No grants — agents get no stored credentials.
            </p>
          ) : (
            <GrantDetails grants={grants} secrets={data.secrets} agents={data.agents} />
          )}
        </CardContent>
      </Card>
    </div>
  );
};
