/** Display labels never establish company or installation identity. */
export function companyOptionIdentity(option:{id:string;connectionId:string;accessCompanyId?:string;financialYear:string}) {
  return JSON.stringify([option.connectionId,option.accessCompanyId||option.id,option.financialYear]);
}
