-- Local addition: Cedar policies become one statement per row, each with an
-- on/off flag. Replaces the single-document cedar_policies table (its content
-- is recreated as rows by the operator; Cedar text cannot be split in SQL).
CREATE TABLE "cedar_policy_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "policy_text" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cedar_policy_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cedar_policy_rules_workspace_id_name_key" ON "cedar_policy_rules"("workspace_id", "name");
CREATE INDEX "cedar_policy_rules_workspace_id_idx" ON "cedar_policy_rules"("workspace_id");

ALTER TABLE "cedar_policy_rules" ADD CONSTRAINT "cedar_policy_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cedar_policy_rules" ADD CONSTRAINT "cedar_policy_rules_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP TABLE "cedar_policies";
