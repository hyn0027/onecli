import { Suspense } from "react";
import type { Metadata } from "next";
import { CredentialsSection } from "../_components/credentials-section";

export const metadata: Metadata = {
  title: "Credentials",
};

interface Props {
  params: Promise<{ agentId: string }>;
}

/** Local addition: the agent's model, LLM keys, workspace-wide credentials it
 *  uses, and its own apps and keys, in one section. */
export default async function AgentCredentialsPage({ params }: Props) {
  const { agentId } = await params;
  return (
    <Suspense>
      <CredentialsSection agentId={agentId} />
    </Suspense>
  );
}
