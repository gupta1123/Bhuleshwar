-- Stable, explicitly verified company routing survives replacement connector
-- sessions. This migration is additive and does not infer identity from names,
-- email addresses, machine names, or the active company alone.
begin;

create table public.access_company_installation_links (
  organization_id text not null references public.access_organizations(id) on delete cascade,
  installation_id text not null check (length(trim(installation_id)) > 0),
  company_guid text not null check (length(trim(company_guid)) > 0),
  financial_year text not null check (length(trim(financial_year)) > 0),
  company_id uuid not null,
  verified_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  evidence text not null check (length(trim(evidence)) > 0),
  source_connection_id uuid references public.tally_connections(id) on delete set null,
  primary key (organization_id, installation_id, company_guid, financial_year),
  foreign key (organization_id, company_id)
    references public.access_companies(organization_id, id)
);

create index access_company_installation_links_company
  on public.access_company_installation_links(organization_id, company_id, installation_id);

alter table public.access_company_installation_links enable row level security;
revoke all on public.access_company_installation_links from public, anon, authenticated;
grant select, insert, update, delete on public.access_company_installation_links to service_role;

-- Refuse an ambiguous historical identity rather than picking the newest row.
do $$
begin
  if exists (
    select 1
      from public.access_company_links
     group by organization_id, installation_id, company_guid, financial_year
    having count(distinct company_id) > 1
  ) then
    raise exception 'Conflicting historical Tally company mappings require review before this migration can be applied';
  end if;
end $$;

insert into public.access_company_installation_links (
  organization_id, installation_id, company_guid, financial_year, company_id,
  verified_at, last_seen_at, evidence, source_connection_id
)
select distinct on (organization_id, installation_id, company_guid, financial_year)
  organization_id, installation_id, company_guid, financial_year, company_id,
  verified_at, now(), 'backfilled-from-verified-connection-link', connection_id
from public.access_company_links
order by organization_id, installation_id, company_guid, financial_year, verified_at desc
on conflict (organization_id, installation_id, company_guid, financial_year) do nothing;

commit;
