DO $$
DECLARE
  facts bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM platform_control_operators)
    +(SELECT count(*) FROM admin_control_config_revisions)
    +(SELECT count(*) FROM admin_control_provider_probes)
    +(SELECT count(*) FROM admin_control_active_configs)
    +(SELECT count(*) FROM admin_control_activation_events)
    +(SELECT count(*) FROM admin_control_commands)
    +(SELECT count(*) FROM admin_control_audits)
    +(SELECT count(*) FROM run_runtime_config_snapshots)
    INTO facts;
  IF facts <> 0 THEN
    RAISE EXCEPTION '后台控制面已有事实，禁止破坏性回退';
  END IF;
END $$;

DROP VIEW admin_runtime_statistics;
DROP POLICY runtime_control_revisions_read_policy ON admin_control_config_revisions;
DROP TABLE run_runtime_config_snapshots;
DROP TABLE admin_control_generation;
DROP TABLE admin_control_audits;
DROP TABLE admin_control_commands;
DROP TABLE admin_control_activation_events;
DROP TABLE admin_control_active_configs;
DROP TABLE admin_control_provider_probes;
DROP TABLE admin_control_config_revisions;
DROP TABLE platform_control_operators;
