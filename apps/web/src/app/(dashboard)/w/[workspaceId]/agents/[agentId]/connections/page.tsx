import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ workspaceId: string; agentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Local change: this section is now part of Credentials; old links land there
 *  with their query (e.g. ?tab=custom, ?connection=...&manage=1) kept. */
export default async function AgentConnectionsRedirect({
  params,
  searchParams,
}: Props) {
  const { workspaceId, agentId } = await params;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(v) ? v : v === undefined ? [] : [v])
      query.append(k, item);
  }
  const q = query.toString();
  redirect(
    `/w/${workspaceId}/agents/${agentId}/credentials${q ? `?${q}` : ""}`,
  );
}
