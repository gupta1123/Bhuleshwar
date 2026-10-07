alter table public.tally_bridge_commands
drop constraint if exists tally_bridge_commands_command_type_check;

alter table public.tally_bridge_commands
add constraint tally_bridge_commands_command_type_check
check (
  command_type in (
    'alter_ledger',
    'sync_masters'
  )
);
