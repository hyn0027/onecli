import type { Metadata } from "next";
import { PoliciesSection } from "../_components/policies-section";

export const metadata: Metadata = {
  title: "Policies",
};

interface Props {
  params: Promise<{ agentId: string }>;
}

/** Local addition: the Cedar policy groups that belong to this agent alone. */
export default async function AgentPoliciesPage({ params }: Props) {
  const { agentId } = await params;
  return <PoliciesSection agentId={agentId} />;
}
