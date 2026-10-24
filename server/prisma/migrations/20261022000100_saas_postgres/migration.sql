BEGIN;
-- CreateTable
CREATE TABLE "system_settings" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_logs" (
    "id" SERIAL NOT NULL,
    "event" TEXT NOT NULL,
    "metadata" TEXT,
    "userId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_prompt_variables" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_prompt_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ep_tenants" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "ep_tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "wechatIdentity" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "pfpFilename" TEXT,
    "bio" TEXT DEFAULT '',
    "seen_recovery_codes" BOOLEAN DEFAULT false,
    "web_push_subscription_config" TEXT,
    "dailyMessageLimit" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "authVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "code_hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ep_platform_accounts" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "authVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "ep_platform_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ep_connections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "secret" TEXT,
    "options" TEXT NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "available" INTEGER NOT NULL DEFAULT 1,
    "isDefault" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "ep_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ep_rag_settings" (
    "tenantId" TEXT NOT NULL,
    "settings" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "ep_rag_settings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "ep_libraries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "ep_libraries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ep_library_grants" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" INTEGER,

    CONSTRAINT "ep_library_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ep_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "inputType" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "metadata" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "originalPath" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "embeddingId" TEXT,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "ep_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ep_chunks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "metadata" TEXT,
    "content" TEXT NOT NULL,
    "embeddingId" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "namespace" TEXT NOT NULL,

    CONSTRAINT "ep_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ep_vector_settings" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'lancedb',
    "config" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "ep_vector_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ep_vector_cleanup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "ep_vector_cleanup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ep_file_cleanup" (
    "path" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "ep_file_cleanup_pkey" PRIMARY KEY ("path")
);

-- CreateTable
CREATE TABLE "chat_threads" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chats" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "thread_id" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "include" BOOLEAN NOT NULL DEFAULT true,
    "api_session_id" TEXT,
    "feedbackScore" BOOLEAN,
    "memory_processed" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ep_knowledge_changes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "libraryId" TEXT,
    "documentId" TEXT,
    "action" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "baseVersion" INTEGER,
    "baseUpdatedAt" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    "reviewedAt" TEXT,

    CONSTRAINT "ep_knowledge_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_agent_invocations" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "tenantId" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "thread_id" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_agent_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slash_command_presets" (
    "id" SERIAL NOT NULL,
    "command" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slash_command_presets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_routers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "fallback_provider" TEXT NOT NULL,
    "fallback_model" TEXT NOT NULL,
    "cooldown_seconds" INTEGER NOT NULL DEFAULT 30,
    "created_by" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_routers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_router_rules" (
    "id" SERIAL NOT NULL,
    "router_id" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'calculated',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "condition_logic" TEXT,
    "conditions" TEXT,
    "route_provider" TEXT NOT NULL,
    "route_model" TEXT NOT NULL,
    "created_by" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_router_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cache_data" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "belongsTo" TEXT,
    "byId" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cache_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT,
    "secret" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_extension_api_keys" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "browser_extension_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "desktop_mobile_devices" (
    "id" SERIAL NOT NULL,
    "deviceOs" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "tenantId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desktop_mobile_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embed_configs" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "chat_mode" TEXT NOT NULL DEFAULT 'query',
    "allowlist_domains" TEXT,
    "allow_model_override" BOOLEAN NOT NULL DEFAULT false,
    "allow_temperature_override" BOOLEAN NOT NULL DEFAULT false,
    "allow_prompt_override" BOOLEAN NOT NULL DEFAULT false,
    "max_chats_per_day" INTEGER,
    "max_chats_per_session" INTEGER,
    "message_limit" INTEGER DEFAULT 20,
    "tenantId" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embed_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embed_chats" (
    "id" SERIAL NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "include" BOOLEAN NOT NULL DEFAULT true,
    "connection_information" TEXT,
    "embed_id" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embed_chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_communication_connectors" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "botId" TEXT,
    "type" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_communication_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "tools" TEXT,
    "schedule" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_job_runs" (
    "id" SERIAL NOT NULL,
    "jobId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),

    CONSTRAINT "scheduled_job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temporary_auth_tokens" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "authVersion" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temporary_auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_parsed_files" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "threadId" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "metadata" TEXT,
    "tokenCountEstimate" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_parsed_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sync_queues" (
    "id" SERIAL NOT NULL,
    "documentId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "staleAfterMs" INTEGER NOT NULL DEFAULT 604800000,
    "nextSyncAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_sync_queues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sync_executions" (
    "id" SERIAL NOT NULL,
    "queueId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_sync_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_history" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "modifiedBy" TEXT,
    "modifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suggested_messages" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "heading" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suggested_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_label_key" ON "system_settings"("label");

-- CreateIndex
CREATE INDEX "event_logs_event_idx" ON "event_logs"("event");

-- CreateIndex
CREATE INDEX "event_logs_userId_idx" ON "event_logs"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "system_prompt_variables_key_key" ON "system_prompt_variables"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ep_tenants_code_key" ON "ep_tenants"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ep_tenants_hostname_key" ON "ep_tenants"("hostname");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_username_key" ON "users"("tenantId", "username");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_wechatIdentity_key" ON "users"("tenantId", "wechatIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_id_key" ON "users"("tenantId", "id");

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_key" ON "password_reset_tokens"("token");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ep_platform_accounts_username_key" ON "ep_platform_accounts"("username");

-- CreateIndex
CREATE INDEX "ep_libraries_scope" ON "ep_libraries"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ep_libraries_tenantId_id_key" ON "ep_libraries"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ep_library_grants_tenantId_idx" ON "ep_library_grants"("tenantId");

-- CreateIndex
CREATE INDEX "ep_library_grants_userId_idx" ON "ep_library_grants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ep_library_grants_libraryId_tenantId_key" ON "ep_library_grants"("libraryId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ep_library_grants_libraryId_userId_key" ON "ep_library_grants"("libraryId", "userId");

-- CreateIndex
CREATE INDEX "ep_documents_scope" ON "ep_documents"("tenantId", "libraryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ep_documents_tenantId_id_key" ON "ep_documents"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ep_chunks_document" ON "ep_chunks"("tenantId", "documentId", "version", "embeddingId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_threads_slug_key" ON "chat_threads"("slug");

-- CreateIndex
CREATE INDEX "chat_threads_tenantId_userId_lastUpdatedAt_idx" ON "chat_threads"("tenantId", "userId", "lastUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "chat_threads_tenantId_userId_id_key" ON "chat_threads"("tenantId", "userId", "id");

-- CreateIndex
CREATE INDEX "chats_tenantId_userId_thread_id_id_idx" ON "chats"("tenantId", "userId", "thread_id", "id");

-- CreateIndex
CREATE INDEX "ep_knowledge_changes_tenantId_status_createdAt_idx" ON "ep_knowledge_changes"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ep_knowledge_changes_requestedBy_createdAt_idx" ON "ep_knowledge_changes"("requestedBy", "createdAt");

-- CreateIndex
CREATE INDEX "memories_tenantId_user_id_idx" ON "memories"("tenantId", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_agent_invocations_uuid_key" ON "workspace_agent_invocations"("uuid");

-- CreateIndex
CREATE INDEX "workspace_agent_invocations_tenantId_user_id_thread_id_idx" ON "workspace_agent_invocations"("tenantId", "user_id", "thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "slash_command_presets_tenantId_userId_command_key" ON "slash_command_presets"("tenantId", "userId", "command");

-- CreateIndex
CREATE UNIQUE INDEX "model_routers_name_key" ON "model_routers"("name");

-- CreateIndex
CREATE INDEX "model_router_rules_router_id_idx" ON "model_router_rules"("router_id");

-- CreateIndex
CREATE INDEX "model_router_rules_router_id_enabled_priority_idx" ON "model_router_rules"("router_id", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "model_router_rules_router_id_title_key" ON "model_router_rules"("router_id", "title");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_secret_key" ON "api_keys"("secret");

-- CreateIndex
CREATE UNIQUE INDEX "browser_extension_api_keys_key_key" ON "browser_extension_api_keys"("key");

-- CreateIndex
CREATE INDEX "browser_extension_api_keys_user_id_idx" ON "browser_extension_api_keys"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "desktop_mobile_devices_token_key" ON "desktop_mobile_devices"("token");

-- CreateIndex
CREATE INDEX "desktop_mobile_devices_userId_idx" ON "desktop_mobile_devices"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "embed_configs_uuid_key" ON "embed_configs"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "external_communication_connectors_botId_key" ON "external_communication_connectors"("botId");

-- CreateIndex
CREATE UNIQUE INDEX "external_communication_connectors_tenantId_type_key" ON "external_communication_connectors"("tenantId", "type");

-- CreateIndex
CREATE INDEX "scheduled_job_runs_jobId_idx" ON "scheduled_job_runs"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "temporary_auth_tokens_token_key" ON "temporary_auth_tokens"("token");

-- CreateIndex
CREATE INDEX "temporary_auth_tokens_token_idx" ON "temporary_auth_tokens"("token");

-- CreateIndex
CREATE INDEX "temporary_auth_tokens_userId_idx" ON "temporary_auth_tokens"("userId");

-- CreateIndex
CREATE INDEX "workspace_parsed_files_tenantId_userId_threadId_idx" ON "workspace_parsed_files"("tenantId", "userId", "threadId");

-- CreateIndex
CREATE UNIQUE INDEX "document_sync_queues_documentId_key" ON "document_sync_queues"("documentId");

-- CreateIndex
CREATE INDEX "prompt_history_tenantId_idx" ON "prompt_history"("tenantId");

-- CreateIndex
CREATE INDEX "suggested_messages_tenantId_idx" ON "suggested_messages"("tenantId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "ep_tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ep_connections" ADD CONSTRAINT "ep_connections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "ep_tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ep_rag_settings" ADD CONSTRAINT "ep_rag_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "ep_tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ep_libraries" ADD CONSTRAINT "ep_libraries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "ep_tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ep_library_grants" ADD CONSTRAINT "ep_library_grants_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "ep_libraries"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ep_library_grants" ADD CONSTRAINT "ep_library_grants_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "ep_tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ep_library_grants" ADD CONSTRAINT "ep_library_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ep_documents" ADD CONSTRAINT "ep_documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "ep_tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ep_documents" ADD CONSTRAINT "ep_documents_tenantId_libraryId_fkey" FOREIGN KEY ("tenantId", "libraryId") REFERENCES "ep_libraries"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ep_chunks" ADD CONSTRAINT "ep_chunks_tenantId_documentId_fkey" FOREIGN KEY ("tenantId", "documentId") REFERENCES "ep_documents"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "ep_tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_tenantId_userId_thread_id_fkey" FOREIGN KEY ("tenantId", "userId", "thread_id") REFERENCES "chat_threads"("tenantId", "userId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "model_router_rules" ADD CONSTRAINT "model_router_rules_router_id_fkey" FOREIGN KEY ("router_id") REFERENCES "model_routers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_extension_api_keys" ADD CONSTRAINT "browser_extension_api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desktop_mobile_devices" ADD CONSTRAINT "desktop_mobile_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embed_chats" ADD CONSTRAINT "embed_chats_embed_id_fkey" FOREIGN KEY ("embed_id") REFERENCES "embed_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_job_runs" ADD CONSTRAINT "scheduled_job_runs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "scheduled_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temporary_auth_tokens" ADD CONSTRAINT "temporary_auth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_sync_queues" ADD CONSTRAINT "document_sync_queues_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ep_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_sync_executions" ADD CONSTRAINT "document_sync_executions_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "document_sync_queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_history" ADD CONSTRAINT "prompt_history_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "ep_tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- SaaS invariants and the platform vector backend default.
ALTER TABLE "ep_tenants" ADD CONSTRAINT "ep_tenants_status_check" CHECK ("status" IN ('active','disabled'));
ALTER TABLE "ep_tenants" ADD CONSTRAINT "ep_tenants_code_normalized" CHECK ("code" = lower("code"));
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('admin','user'));
ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK ("status" IN ('active','disabled'));
ALTER TABLE "users" ADD CONSTRAINT "users_username_normalized" CHECK ("username" = lower("username"));
ALTER TABLE "users" ADD CONSTRAINT "users_auth_version_check" CHECK ("authVersion" > 0);
ALTER TABLE "ep_platform_accounts" ADD CONSTRAINT "ep_platform_accounts_username_normalized" CHECK ("username" = lower("username"));
ALTER TABLE "ep_platform_accounts" ADD CONSTRAINT "ep_platform_accounts_status_check" CHECK ("status" IN ('active','disabled'));
ALTER TABLE "ep_platform_accounts" ADD CONSTRAINT "ep_platform_accounts_auth_version_check" CHECK ("authVersion" > 0);
ALTER TABLE "ep_connections" ADD CONSTRAINT "ep_connections_scope_check" CHECK (("scope" = 'platform' AND "tenantId" IS NULL) OR ("scope" = 'tenant' AND "tenantId" IS NOT NULL));
ALTER TABLE "ep_connections" ADD CONSTRAINT "ep_connections_kind_check" CHECK ("kind" IN ('chat','embedding'));
ALTER TABLE "ep_connections" ADD CONSTRAINT "ep_connections_flags_check" CHECK ("available" IN (0,1) AND "isDefault" IN (0,1) AND "version" > 0);
CREATE UNIQUE INDEX "ep_connection_default" ON "ep_connections" (COALESCE("tenantId", ''), "kind") WHERE "isDefault" = 1;
ALTER TABLE "ep_chunks" ADD CONSTRAINT "ep_chunks_dimensions_check" CHECK ("dimensions" > 0 AND "version" > 0 AND length("namespace") > 0);
ALTER TABLE "ep_vector_settings" ADD CONSTRAINT "ep_vector_settings_singleton_check" CHECK ("id" = 'platform' AND "revision" > 0);
INSERT INTO "ep_vector_settings" ("id","provider","config","revision","updatedAt") VALUES ('platform','lancedb',NULL,1,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

ALTER TABLE ep_tenants ADD CONSTRAINT ep_tenants_hostname_normalized CHECK (hostname=lower(hostname) AND length(hostname) BETWEEN 3 AND 253);

CREATE FUNCTION prevent_user_tenant_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    RAISE EXCEPTION 'A user cannot change enterprise ownership' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_tenant_immutable BEFORE UPDATE OF "tenantId" ON users
FOR EACH ROW EXECUTE FUNCTION prevent_user_tenant_change();

ALTER TABLE ep_library_grants ADD CONSTRAINT ep_library_grants_subject_check CHECK (("tenantId" IS NOT NULL)::int + ("userId" IS NOT NULL)::int = 1);
COMMIT;
