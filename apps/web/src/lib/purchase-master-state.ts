export function purchaseMasterReadiness(input: {
  posted: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  supplierMatching: boolean;
  lineMatching: boolean;
  ready: boolean;
}) {
  const checking = !input.posted && (input.initialLoading || input.refreshing || input.supplierMatching || input.lineMatching);
  return { checking, unavailable: !input.posted && !input.ready && !checking };
}
