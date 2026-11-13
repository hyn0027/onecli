/**
 * Local addition: exclude agents from a workspace-wide Cedar policy without changing
 * what the user wrote (see services/workspace-layers-service.ts). No imports, so it
 * can be tested and reused on its own.
 */

/** A Cedar statement with `unless { principal in [...] }` added before its final `;`.
 *  Unchanged when there is nobody to exclude. */
export const withExclusions = (
  policyText: string,
  agentIds: string[],
): string => {
  if (agentIds.length === 0) return policyText;
  // Trailing line comments and whitespace sit after the statement's `;`.
  const lines = policyText.replace(/\s+$/, "").split("\n");
  while (
    lines.length > 0 &&
    /^\s*(\/\/.*)?$/.test(lines[lines.length - 1] ?? "")
  )
    lines.pop();
  const body = lines.join("\n");
  const end = body.lastIndexOf(";");
  if (end === -1) return policyText;
  const set = agentIds
    .map((id) => `OneCLI::Agent::"${id.replace(/["\\]/g, "")}"`)
    .join(", ");
  return `${body.slice(0, end).replace(/\s+$/, "")}\nunless { principal in [${set}] };`;
};
