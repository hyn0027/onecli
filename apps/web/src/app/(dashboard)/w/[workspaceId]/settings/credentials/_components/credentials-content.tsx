"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cedarPolicy } from "@/lib/api";
import type { AgentRef, SecretConfig } from "@/lib/api/cedar-policy";
import { AgentUses, usesSummary } from "../../policy/_components/agent-uses";
import { POLICY_QUERY_KEY } from "../../policy/_components/cedar-policies";
import { SecretCard } from "../../policy/_components/grant-details";

/**
 * Local addition: the workspace layer of credentials. A workspace-wide credential
 * is granted to every agent except the ones switched off here (agents created
 * later are on). Everything else an agent holds is its own layer, managed on its
 * page.
 */

const useShare = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      shared,
      excludedAgentIds,
    }: {
      id: string;
      shared: boolean;
      excludedAgentIds?: string[];
    }) => cedarPolicy.setSharedCredential(id, { shared, excludedAgentIds }),
    onSuccess: (res) => {
      const parts = [
        res.granted.length > 0 && `granted to ${res.granted.length}`,
        res.revoked.length > 0 && `removed from ${res.revoked.length}`,
      ].filter(Boolean);
      toast.success(
        parts.length > 0
          ? `Saved: ${parts.join(", ")} ${res.granted.length + res.revoked.length === 1 ? "agent" : "agents"}`
          : "Saved",
      );
      void qc.invalidateQueries({ queryKey: POLICY_QUERY_KEY });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not save"),
  });
};

const SharedRow = ({
  secret,
  agents,
}: {
  secret: SecretConfig;
  agents: AgentRef[];
}) => {
  const [open, setOpen] = useState(false);
  const share = useShare();
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((o) => !o);
        }}
        className="hover:bg-muted/50 flex cursor-pointer flex-wrap items-center gap-3 px-4 py-3"
      >
        <span className="text-muted-foreground" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="font-medium">{secret.name}</span>
        <Badge variant="outline">{secret.type}</Badge>
        <code className="text-muted-foreground text-xs">
          {secret.hostPattern}
        </code>
        <span className="text-muted-foreground ml-auto text-sm tabular-nums">
          used by {usesSummary(agents, secret.sharedExcludedAgentIds)}
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-3 border-t px-4 py-3">
          <AgentUses
            agents={agents}
            excluded={secret.sharedExcludedAgentIds}
            disabled={share.isPending}
            onChange={(ids) =>
              share.mutate({
                id: secret.id,
                shared: true,
                excludedAgentIds: ids,
              })
            }
          />
          <SecretCard secret={secret} />
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={share.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Stop sharing ${secret.name} workspace-wide? Every agent using it now loses it; attach it to single agents on their pages instead.`,
                  )
                ) {
                  share.mutate({ id: secret.id, shared: false });
                }
              }}
            >
              Stop sharing workspace-wide
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export const CredentialsContent = () => {
  const { data, isLoading, error } = useQuery({
    queryKey: POLICY_QUERY_KEY,
    queryFn: cedarPolicy.get,
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !data) {
    return (
      <Card className="p-6 text-sm">
        Could not load credentials:{" "}
        {error instanceof Error ? error.message : "unknown error"}
      </Card>
    );
  }
  const shared = data.secrets.filter(
    (s) => s.scope === "workspace" && s.workspaceShared,
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Workspace-wide credentials</CardTitle>
          <CardDescription>
            Injected for every agent that uses them. Open one to choose which
            agents do. Values are never shown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y rounded-lg border">
            {shared.map((s) => (
              <SharedRow key={s.id} secret={s} agents={data.agents} />
            ))}
            {shared.length === 0 && (
              <p className="text-muted-foreground p-4 text-sm">
                No workspace-wide credentials.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
