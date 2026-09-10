-- Cube 代理与服务地址共同构成版本化连接身份；保留已执行的 0064 原始校验和。
ALTER TABLE sandbox_provider_profiles DROP CONSTRAINT sandbox_provider_profiles_configuration_check2;
ALTER TABLE sandbox_provider_profiles ADD CONSTRAINT sandbox_provider_profiles_configuration_check2
  CHECK (configuration-ARRAY['providerKey','displayName','endpoint','credentialConfigured','policy','cubeProxy']='{}'::jsonb);
ALTER TABLE sandbox_provider_profiles ADD CONSTRAINT sandbox_provider_profiles_cube_proxy_check
  CHECK (NOT configuration ? 'cubeProxy' OR (
    provider_key='cube' AND jsonb_typeof(configuration->'cubeProxy')='object'
    AND (configuration->'cubeProxy') ?& ARRAY['host','port','scheme']
    AND (configuration->'cubeProxy')-ARRAY['host','port','scheme']='{}'::jsonb
    AND configuration->'cubeProxy'->>'scheme' IN ('http','https')
  ));
