DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM sandbox_provider_profiles WHERE configuration ? 'cubeProxy') THEN
    RAISE EXCEPTION '不可丢弃已持久化的 Cube 代理连接身份';
  END IF;
END $$;
ALTER TABLE sandbox_provider_profiles DROP CONSTRAINT sandbox_provider_profiles_cube_proxy_check;
ALTER TABLE sandbox_provider_profiles DROP CONSTRAINT sandbox_provider_profiles_configuration_check2;
ALTER TABLE sandbox_provider_profiles ADD CONSTRAINT sandbox_provider_profiles_configuration_check2
  CHECK (configuration-ARRAY['providerKey','displayName','endpoint','credentialConfigured','policy']='{}'::jsonb);
