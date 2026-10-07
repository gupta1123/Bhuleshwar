-- Optional repair for organization-aware connector identities introduced after
-- legacy connections were already paired. Apply manually after reviewing the
-- target project. Runtime heartbeat repair handles active installations too.
with candidate as (
  select member.user_id,
         coalesce(
           max(member.organization_id) filter (where member.organization_id = member.user_id::text),
           min(member.organization_id) filter (where totals.organization_count = 1)
         ) as organization_id
  from public.access_members as member
  join (
    select user_id, count(distinct organization_id) as organization_count
    from public.access_members
    where status = 'active'
    group by user_id
  ) as totals on totals.user_id = member.user_id
  where member.status = 'active'
  group by member.user_id
)
update public.tally_connections as connection
set organization_id = candidate.organization_id
from candidate
where connection.organization_id is null
  and candidate.user_id = connection.owner_user_id
  and candidate.organization_id is not null;
