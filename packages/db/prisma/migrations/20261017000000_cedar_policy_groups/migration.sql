-- Local addition: Cedar policy groups. Every policy belongs to a group with its
-- own on/off switch; a policy applies only when it and its group are both on.
-- Existing policies move into a "default" group per workspace.
CREATE TABLE "cedar_policy_groups" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cedar_policy_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cedar_policy_groups_workspace_id_name_key" ON "cedar_policy_groups"("workspace_id", "name");
CREATE UNIQUE INDEX "cedar_policy_groups_workspace_id_source_key" ON "cedar_policy_groups"("workspace_id", "source");
CREATE INDEX "cedar_policy_groups_workspace_id_idx" ON "cedar_policy_groups"("workspace_id");

ALTER TABLE "cedar_policy_groups" ADD CONSTRAINT "cedar_policy_groups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cedar_policy_groups" ADD CONSTRAINT "cedar_policy_groups_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "cedar_policy_groups" ("id", "workspace_id", "name", "description", "updated_at")
SELECT gen_random_uuid()::text, w."workspace_id", 'default', 'Policies created before groups existed', CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "workspace_id" FROM "cedar_policy_rules") w;

ALTER TABLE "cedar_policy_rules" ADD COLUMN "group_id" TEXT;
UPDATE "cedar_policy_rules" r SET "group_id" = g."id"
FROM "cedar_policy_groups" g WHERE g."workspace_id" = r."workspace_id" AND g."name" = 'default';
ALTER TABLE "cedar_policy_rules" ALTER COLUMN "group_id" SET NOT NULL;
ALTER TABLE "cedar_policy_rules" ADD CONSTRAINT "cedar_policy_rules_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "cedar_policy_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX "cedar_policy_rules_workspace_id_name_key";
CREATE UNIQUE INDEX "cedar_policy_rules_group_id_name_key" ON "cedar_policy_rules"("group_id", "name");
