/**
 * Local addition: who may change a workspace's gateway policies and its
 * workspace-wide credentials (routes/cedar-policy.ts).
 *
 * Our own check, written against the Apache-licensed schema only. It does not
 * use or mirror anything under an `ee/` directory (the OneCLI Enterprise License):
 * the caller must be an active member of the workspace's organization with the
 * role "owner" or "admin". A workspace-scoped API key is confined to its own
 * workspace. A member who can see the workspace but is not an admin gets 403; anyone
 * else gets 404, so a workspace's existence is not revealed.
 */
import { db } from "@onecli/db";
import type { AuthContext } from "../providers";
import { ServiceError } from "../services/errors";

const ADMIN_ROLES = new Set(["owner", "admin"]);

export const requireWorkspaceAdmin = async (
  auth: AuthContext,
  workspaceId: string,
): Promise<void> => {
  if (auth.scope === "workspace" && auth.workspaceId !== workspaceId) {
    throw new ServiceError("NOT_FOUND", "Workspace not found");
  }
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  const member = workspace
    ? await db.organizationMember.findFirst({
        where: {
          organizationId: workspace.organizationId,
          userId: auth.userId,
          status: "active",
        },
        select: { role: true },
      })
    : null;
  if (!member) throw new ServiceError("NOT_FOUND", "Workspace not found");
  if (!ADMIN_ROLES.has(member.role)) {
    throw new ServiceError(
      "FORBIDDEN",
      "Only workspace owners and admins can change gateway policies and credentials",
    );
  }
};
