drop constraint if exists tally_bridge_commands_command_type_check;

alter table public.tally_bridge_commands
add constraint tally_bridge_commands_command_type_check
check (
  command_type in (
    'sync_masters',
    'alter_ledger',
    'create_ledger',
    'post_bank_voucher',
    'fetch_customer_open_bills'
  )
);
