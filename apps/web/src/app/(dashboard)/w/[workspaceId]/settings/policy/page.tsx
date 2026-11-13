import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { PolicyContent } from "./_components/policy-content";

export const metadata: Metadata = {
  title: "Policy",
};

/** Local addition: what this workspace's agents may reach: the gateway's default
 *  posture and the workspace-wide Cedar policies. Credentials: Settings → Credentials. */
export default function WorkspacePolicyPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Policy"
        description="What this workspace's agents may reach through the gateway: the default posture and the workspace-wide Cedar policies that decide every request. Each agent's own policies are on its page; credentials are under Credentials."
      />
      <PolicyContent />
    </div>
  );
}
