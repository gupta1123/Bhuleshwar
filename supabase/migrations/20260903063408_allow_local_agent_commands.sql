-- Follow-up for installations that applied Local Agent v1 before its command
-- types were added to the historical tally_bridge_commands check constraint.
-- Safe to run repeatedly and intentionally does not alter accounting data.

do $$
begin
  if to_regclass('public.tally_bridge_commands') is not null then
    alter table public.tally_bridge_commands
      drop constraint if exists tally_bridge_commands_command_type_check;

    alter table public.tally_bridge_commands
      add constraint tally_bridge_commands_command_type_check
      check (command_type in (
        'alter_ledger', 'create_ledger', 'fetch_bank_ledgers', 'fetch_purchase_masters',
        'sync_masters', 'post_bank_voucher', 'post_purchase_voucher',
        'fetch_customer_open_bills', 'create_debit_note', 'export_debit_note_pdf',
        'verify_bank_transaction', 'create_purchase_voucher', 'agent_sync_dataset',
        'agent_reconcile_dataset', 'agent_parse_document', 'agent_vector_suggest',
        'agent_cache_maintenance', 'agent_clear_cache', 'agent_update_settings',
        'agent_rebuild_cache', 'agent_diagnostics', 'agent_query_open_bills',
        'agent_query_workflow_vouchers', 'agent_voucher_identity'
      ));
  end if;
end
$$;
