-- Local addition: Cedar policy documents (one per workspace), read by the
-- gateway in GATEWAY_POLICY_ENGINE=cedar mode.
CREATE TABLE "cedar_policies" (
    "workspace_id" TEXT NOT NULL,
    "policy_text" TEXT NOT NULL,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cedar_policies_pkey" PRIMARY KEY ("workspace_id")
);

ALTER TABLE "cedar_policies" ADD CONSTRAINT "cedar_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cedar_policies" ADD CONSTRAINT "cedar_policies_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
