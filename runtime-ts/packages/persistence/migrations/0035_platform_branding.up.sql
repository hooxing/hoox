CREATE TABLE platform_branding (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration)='object'),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_branding(configuration) VALUES ('{"productName":"Hoox","logoDataUrl":null,"primaryColor":null,"footerLinks":[],"hiddenModules":[]}');
CREATE TABLE platform_branding_audits (
  request_id text PRIMARY KEY,
  actor_user_id text NOT NULL,
  input_digest text NOT NULL,
  generation integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_branding FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_branding_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_branding_audits FORCE ROW LEVEL SECURITY;
CREATE POLICY branding_owner ON platform_branding TO PUBLIC USING (false) WITH CHECK (false);
CREATE POLICY branding_admin ON platform_branding TO PUBLIC USING (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting('app.user_id',true),'') AND role='admin' AND status='active')) WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting('app.user_id',true),'') AND role='admin' AND status='active'));
CREATE POLICY branding_audit_owner ON platform_branding_audits TO PUBLIC USING (false) WITH CHECK (false);
CREATE POLICY branding_audit_admin ON platform_branding_audits TO PUBLIC USING (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting('app.user_id',true),'') AND role='admin' AND status='active')) WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting('app.user_id',true),'') AND role='admin' AND status='active'));
CREATE VIEW public_branding WITH (security_barrier=true) AS
SELECT jsonb_build_object('productName',configuration->'productName','logoDataUrl',configuration->'logoDataUrl','primaryColor',configuration->'primaryColor','footerLinks',configuration->'footerLinks','hiddenModules',configuration->'hiddenModules') AS configuration FROM platform_branding;
DO $$ BEGIN
  EXECUTE format('ALTER POLICY branding_owner ON platform_branding TO %I USING (true) WITH CHECK (true)',current_user);
  EXECUTE format('ALTER POLICY branding_audit_owner ON platform_branding_audits TO %I USING (true) WITH CHECK (true)',current_user);
  EXECUTE format('ALTER POLICY branding_admin ON platform_branding TO %I',current_setting('app.admin_control_role'));
  EXECUTE format('ALTER POLICY branding_audit_admin ON platform_branding_audits TO %I',current_setting('app.admin_control_role'));
  EXECUTE format('GRANT SELECT ON public_branding TO %I',current_setting('app.runtime_role'));
  EXECUTE format('GRANT SELECT,UPDATE ON platform_branding TO %I',current_setting('app.admin_control_role'));
  EXECUTE format('GRANT SELECT,INSERT ON platform_branding_audits TO %I',current_setting('app.admin_control_role'));
END $$;
