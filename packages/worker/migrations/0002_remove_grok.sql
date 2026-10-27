DELETE FROM credentials WHERE provider = 'grok';
DELETE FROM current_quotas WHERE provider = 'grok';
DELETE FROM snapshots WHERE provider = 'grok';
DELETE FROM period_closes WHERE provider = 'grok';
DELETE FROM provider_health WHERE provider = 'grok';
DELETE FROM sent_alerts WHERE key LIKE '%grok%';
DELETE FROM leases WHERE name = 'provider:grok';
