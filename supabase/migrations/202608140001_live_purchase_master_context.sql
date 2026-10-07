-- Allow the connector to return a short-lived, live Purchase-posting master
-- context. The result travels through the existing command queue; it does not
-- populate or replace the tally_masters cache.

do $$
begin
  if to_regclass('public.tally_bridge_commands') is not null then
    alter table public.tally_bridge_commands
      drop constraint if exists tally_bridge_commands_command_type_check;

    alter table public.tally_bridge_commands
      add constraint tally_bridge_commands_command_type_check
      check (
        command_type in (
          'alter_ledger',
          'create_ledger',
          'fetch_bank_ledgers',
          'fetch_purchase_masters',
          'sync_masters',
          'post_bank_voucher',
          'post_purchase_voucher',
          'fetch_customer_open_bills',
          'create_debit_note',
          'export_debit_note_pdf',
          'verify_bank_transaction',
          'create_purchase_voucher'
        )
      );
  end if;
end
$$;
