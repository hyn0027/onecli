"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useCreateThenAttachSecret } from "@/hooks/use-create-then-attach-secret";
import { SecretDialog } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog";
import type { Secret } from "@/lib/api";
import { ModelCard } from "./model-card";
import { SecretGrantsTab } from "./secret-grants-tab";
import { WorkspaceCredentialsCard } from "./workspace-credentials-card";

/**
 * Local addition: what this agent authenticates with, in one section (it replaces
 * the separate Connections and Models sections): the model it runs, the
 * workspace-wide credentials it uses, and the custom keys attached to it alone.
 */
export const CredentialsSection = ({ agentId }: { agentId: string }) => {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Secret | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  // A key created here is attached to THIS agent the moment it lands.
  const { secretActions, onSaved } = useCreateThenAttachSecret(agentId);

  return (
    <div className="flex flex-col gap-10">
      <ModelCard agentId={agentId} />
      <WorkspaceCredentialsCard agentId={agentId} />
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">This agent only</h2>
            <p className="text-muted-foreground text-sm">
              Custom keys attached to this agent alone.
            </p>
          </div>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            Add key
          </Button>
        </div>
        <SecretGrantsTab
          agentId={agentId}
          kind="secret"
          onAdd={() => setAdding(true)}
          onEdit={(secret) => {
            setEditing(secret);
            setEditOpen(true);
          }}
        />
      </div>
      <SecretDialog
        open={adding}
        onOpenChange={setAdding}
        onSaved={onSaved}
        defaultType="generic"
        secretActions={secretActions}
      />
      {editing && (
        <SecretDialog
          key={editing.id}
          open={editOpen}
          onOpenChange={(open) => {
            if (!open) setEditOpen(false);
          }}
          secret={editing}
        />
      )}
    </div>
  );
};
