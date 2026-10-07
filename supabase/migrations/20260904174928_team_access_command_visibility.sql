-- Backend-only projection. No client Data API access and no activation.
begin;
create view public.access_visible_commands with (security_invoker=true) as
 select b.*,a.company_id as access_company_id,
 case
  when a.permission in ('purchases.view','purchases.prepare','purchases.submit','purchases.approve','purchases.post') then 'purchases.view'
  when a.permission in ('bank.view','bank.prepare','bank.submit','bank.approve','bank.post') then 'bank.view'
  when a.permission in ('discounts.view','discounts.prepare','discounts.submit','discounts.approve','discounts.post') then 'discounts.view'
  when a.permission in ('followups.view','followups.prepare','followups.submit','followups.approve','followups.post') then 'followups.view'
  when a.permission in ('purchases.export','bank.export','discounts.export','followups.export') then a.permission
  when a.permission='connections.manage' then 'connections.manage'
 end as visibility_permission
 from public.tally_bridge_commands b
 join public.access_command_authority a on a.command_id=b.id and a.organization_id=b.organization_id
 join public.tally_connections c on c.id=b.connection_id and c.owner_user_id=b.owner_user_id
  and c.installation_id=b.installation_id and c.session_generation=b.session_generation and c.revoked_at is null
 join public.access_company_links l on l.organization_id=a.organization_id and l.company_id=a.company_id
  and l.connection_id=b.connection_id and l.installation_id=b.installation_id
  and l.company_guid=b.company_guid and l.financial_year=b.financial_year
 -- Document-job tokens, diagnostics and arbitrary future agent payloads are not
 -- exposed by this generic command API. They need their dedicated scoped APIs.
 where b.command_type in ('alter_ledger','create_ledger','sync_masters',
  'fetch_bank_ledgers','fetch_purchase_masters','post_bank_voucher',
  'fetch_customer_open_bills','create_debit_note','export_debit_note_pdf',
  'create_purchase_voucher','verify_bank_transaction');
revoke all on public.access_visible_commands from public,anon,authenticated;
grant select on public.access_visible_commands to service_role;
commit;
