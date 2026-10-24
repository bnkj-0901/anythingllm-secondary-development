ALTER TABLE "users" ADD COLUMN "wechatRegistrationComplete" BOOLEAN NOT NULL DEFAULT true;

-- Existing WeChat accounts were created with an unknown random password.
-- They complete registration once, without replacing their account or history.
UPDATE "users" SET "wechatRegistrationComplete" = false WHERE "wechatIdentity" IS NOT NULL;
