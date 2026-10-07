import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { wakeTallyConnector } from '@/lib/tally/command-wake';
import { serializeTallyBridgeCommand, type TallyBridgeCommandRow } from '@/lib/tally/commands';
import { requireDataset } from './dataset';
import { AccessError } from './server';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccessError('Invalid job metadata.', 400);
  return value as Record<string, unknown>;
}

/** Only read-only financial reports belong here. Document jobs, writes and
 * installation-wide maintenance need their own resource-specific admission. */
export async function queueTeamAgentRead(request: Request, body: Record<string, unknown>) {
  const type = body.commandType;
  const sync = type === 'agent_sync_dataset' || type === 'agent_reconcile_dataset';
  if (!sync && type !== 'agent_query_open_bills' && type !== 'agent_query_workflow_vouchers') {
    throw new AccessError('Use the dedicated scoped workflow for this agent operation.', 409);
  }
  const supplied = object(body.identity);
  const raw = object(body.payload || {});
  if (typeof supplied.connectionId !== 'string' || !supplied.companyGuid || !supplied.financialYear ||
      !supplied.installationId || !Number.isSafeInteger(supplied.sessionGeneration)) {
    throw new AccessError('Select a complete company dataset and pairing session.', 400);
  }
  const { access, link, connection } = await requireDataset(request, supplied.connectionId, {
    companyGuid: supplied.companyGuid, financialYear: supplied.financialYear, companyName: supplied.companyName,
  }, sync ? 'connections.manage' : 'discounts.prepare');
  if (connection.agent_protocol_version !== 1 || !connection.agent_capabilities?.includes('agent-job-envelope-v1')) {
    throw new AccessError('This connector does not support scoped Local Agent reports. Update it first.', 409);
  }
  if (supplied.organizationId !== access.organizationId || supplied.installationId !== connection.installation_id ||
      supplied.sessionGeneration !== connection.session_generation ||
      (supplied.ownerUserId !== undefined && supplied.ownerUserId !== connection.owner_user_id) ||
      supplied.protocolVersion !== 1) {
    throw new AccessError('The selected agent pairing has changed. Refresh the connection.', 409);
  }
  if (sync) {
    if (Object.keys(raw).length) throw new AccessError('Dataset sync does not accept custom payloads.', 400);
    const {data, error} = await createSupabaseAdminClient().rpc('access_enqueue_agent_sync', {
      p_actor: access.member.user_id, p_org: access.organizationId, p_company: link.company_id,
      p_connection: connection.id, p_installation: connection.installation_id, p_generation: connection.session_generation,
      p_owner: connection.owner_user_id, p_guid: link.company_guid, p_year: link.financial_year,
      p_type: type, p_payload: {},
    });
    if (error) throw error;
    if (!data?.id) throw new AccessError('The agent job could not be saved.', 503);
    await wakeTallyConnector(connection.id).catch(() => undefined);
    return {job: serializeTallyBridgeCommand(data as TallyBridgeCommandRow)};
  }
  const year = /^(20\d{2})-(\d{2}|20\d{2})$/.exec(link.financial_year);
  if (!year || Number(year[2].length === 2 ? `20${year[2]}` : year[2]) !== Number(year[1]) + 1) {
    throw new AccessError('The dataset financial year is not supported.', 409);
  }
  const start = `${year[1]}0401`, end = `${Number(year[1]) + 1}0331`;
  function date(value: unknown, fallback: string) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'string' || !/^\d{8}$/.test(value)) throw new AccessError('Use YYYYMMDD report dates.', 400);
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso || value < start || value > end) {
      throw new AccessError('Report dates must be valid dates within the selected financial year.', 400);
    }
    return value;
  }
  const dateFrom = date(raw.dateFrom, start), dateTo = date(raw.dateTo, end);
  if (dateFrom > dateTo) throw new AccessError('The report date range is reversed.', 400);
  if (!Array.isArray(raw.ledgerNames) || !raw.ledgerNames.length || raw.ledgerNames.length > 250 ||
      raw.ledgerNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 500)) {
    throw new AccessError('Select between 1 and 250 ledger names.', 400);
  }
  if (type === 'agent_query_workflow_vouchers' && !['cash_discount', 'turnover_discount'].includes(String(raw.workflow))) {
    throw new AccessError('Select a supported discount workflow.', 400);
  }
  const payload = {
    dateFrom, dateTo, ledgerNames: [...new Set((raw.ledgerNames as string[]).map(name => name.trim()))],
    ...(type === 'agent_query_workflow_vouchers' ? { workflow: raw.workflow } : {}),
  };
  // The database pins the transport owner and writes the actor's authority receipt
  // in the same transaction. No user-supplied XML, identity or callback is forwarded.
  const { data, error } = await createSupabaseAdminClient().rpc('access_enqueue_agent_read', {
    p_actor: access.member.user_id, p_org: access.organizationId, p_company: link.company_id,
    p_connection: connection.id, p_installation: connection.installation_id, p_generation: connection.session_generation,
    p_owner: connection.owner_user_id, p_guid: link.company_guid, p_year: link.financial_year,
    p_type: type, p_payload: payload,
  });
  if (error) throw error;
  if (!data?.id) throw new AccessError('The agent job could not be saved.', 503);
  await wakeTallyConnector(connection.id).catch(() => undefined);
  return { job: serializeTallyBridgeCommand(data as TallyBridgeCommandRow) };
}
