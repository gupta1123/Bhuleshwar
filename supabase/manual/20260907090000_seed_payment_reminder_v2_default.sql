-- Kalika only. Prepared for manual application; do not apply automatically.
-- Seeds the approved reminder schedule only when an organization has not saved
-- Payment Reminder settings yet. Existing/custom settings are never changed.
begin;

insert into public.access_organization_settings(organization_id, setting_key, value)
select
  o.id,
  'payment-reminders',
  jsonb_build_object(
    'onceTemplate', 'payment_reminder_v2',
    'plan', jsonb_build_object(
      'name', 'Standard payment reminders',
      'stages', jsonb_build_array(
        jsonb_build_object('name','First reminder','template','payment_reminder_v2','unit','days','delay',0,'every',1,'limit',1),
        jsonb_build_object('name','Regular follow-up','template','payment_reminder_v2','unit','days','delay',2,'every',2,'limit',3),
        jsonb_build_object('name','Final reminders','template','payment_reminder_v2','unit','days','delay',1,'every',1,'limit',3)
      )
    )
  )
from public.access_organizations o
where not exists (
  select 1
  from public.access_organization_settings s
  where s.organization_id=o.id
    and s.setting_key='payment-reminders'
);

commit;
