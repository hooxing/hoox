DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM sandbox_configuration_bindings) OR EXISTS(SELECT 1 FROM sandbox_provider_profiles) THEN
    RAISE EXCEPTION '托管沙箱配置或实例绑定存在，禁止回退';
  END IF;
END $$;
DROP TABLE sandbox_configuration_bindings;
DROP TABLE sandbox_control_audits;
DROP TABLE sandbox_profile_probes;
DROP TABLE sandbox_control_head;
DROP TABLE sandbox_routing_targets;
DROP TABLE sandbox_routing_revisions;
DROP TABLE sandbox_provider_profiles;
