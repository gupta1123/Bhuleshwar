do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.tally_bridge_commands'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%command_type%';

  if constraint_name is not null then
    execute format('alter table public.tally_bridge_commands drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.tally_bridge_commands
add constraint tally_bridge_commands_command_type_check
check (
  command_type in (
    'alter_ledger',
    'create_ledger',
    'sync_masters',
    'post_bank_voucher'
  )
);
