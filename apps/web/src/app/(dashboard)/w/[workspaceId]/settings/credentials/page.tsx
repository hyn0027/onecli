import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { CredentialsContent } from "./_components/credentials-content";

export const metadata: Metadata = {
  title: "Credentials",
};

/** Local addition: the workspace layer of credentials, which secrets every agent
 *  receives (each agent can be switched off), and where each agent's own are. */
export default function WorkspaceCredentialsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Credentials"
        description="Workspace-wide credentials: the gateway injects them for every agent you leave switched on. Credentials for one agent only are on that agent's page."
      />
      <CredentialsContent />
    </div>
  );
}
