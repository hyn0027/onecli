-- Local addition: two layers (workspace-wide and per agent) for credentials and
-- Cedar policies. A workspace-wide credential is granted to every agent except the
-- excluded ones; a workspace-wide policy group applies to every agent except the
-- excluded ones (enforced through `compiled_text`, which the gateway prefers).
ALTER TABLE "secrets" ADD COLUMN "workspace_shared" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "secrets" ADD COLUMN "shared_excluded_agent_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "cedar_policy_groups" ADD COLUMN "excluded_agent_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "cedar_policy_rules" ADD COLUMN "compiled_text" TEXT;
