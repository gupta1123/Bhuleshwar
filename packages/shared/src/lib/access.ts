export const MODULES = { purchases: 'Purchases', bank: 'Bank statements', discounts: 'Cash discounts', followups: 'Payment follow-ups' } as const;
export type ModuleKey = keyof typeof MODULES;
export const ACTIONS = { view: 'View records and documents', prepare: 'Prepare, correct and analyze', submit: 'Submit for review', approve: 'Approve or return work', post: 'Post approved entries to ERP', export: 'Export and download', recycle: 'Recycle and restore', delete: 'Permanently delete' } as const;
export const ADMIN_PERMISSIONS = { 'team.manage': 'Manage teammates', 'roles.manage': 'Manage roles', 'settings.manage': 'Manage settings', 'connections.manage': 'Manage ERP connections' } as const;
export const PERMISSIONS: Readonly<Record<string,string>> = Object.freeze({
  ...Object.fromEntries(Object.entries(MODULES).flatMap(([m,label])=>Object.entries(ACTIONS).map(([a,action])=>[`${m}.${a}`,`${label}: ${action}`]))), ...ADMIN_PERMISSIONS,
});
export const DEFAULT_ROLES = [
  {key:'administrator',name:'Administrator',description:'Manages the team, settings and connections. Financial access is not automatic.',permissions:Object.keys(ADMIN_PERMISSIONS)},
  {key:'approver',name:'Approver',description:'Prepares and reviews work. Cannot post to ERP by default.',permissions:Object.keys(MODULES).flatMap(m=>['view','prepare','submit','approve'].map(a=>`${m}.${a}`))},
  {key:'operator',name:'Operator',description:'Prepares entries and submits them for review.',permissions:Object.keys(MODULES).flatMap(m=>['view','prepare','submit'].map(a=>`${m}.${a}`))},
  {key:'viewer',name:'View only',description:'Inspects records without changing, downloading or posting them.',permissions:Object.keys(MODULES).map(m=>`${m}.view`)},
] as const;
export type AccessRole = {id:string; name:string; permissions:string[]; revision:number; template_key:string|null; archived:boolean};
export type AccessMember = {user_id:string;organization_id:string;role_id:string;display_name:string;email:string;status:'active'|'suspended';is_owner:boolean;all_companies:boolean;company_ids:string[];modules:ModuleKey[];revision:number;must_change_password:boolean};
export type AccessSnapshot = {organizationId:string;organizationName:string;revision:number;sharingEnabled:boolean;allowSelfApproval:boolean;member:AccessMember;role:AccessRole;companies:Array<{id:string;name:string}>;organizations:Array<{id:string;name:string}>};
export function validatePermissions(keys:readonly string[]):string[] {
  if(keys.length!==new Set(keys).size) throw new Error('Duplicate permissions.');
  for(const key of keys){
    if(!Object.hasOwn(PERMISSIONS,key)) throw new Error(`Unknown permission: ${key}`);
    const [module,action]=key.split('.');
    if(Object.hasOwn(MODULES,module)&&action!=='view'&&!keys.includes(`${module}.view`)) throw new Error(`${MODULES[module as ModuleKey]} access also needs View.`);
    if(action==='submit'&&!keys.includes(`${module}.prepare`)) throw new Error('Submitting also requires permission to prepare.');
  }
  return [...keys].sort();
}
export function canAccess(snapshot:AccessSnapshot|null,permission:string,companyId?:string|null):boolean {
  if(!snapshot||snapshot.member.status!=='active'||snapshot.member.must_change_password||snapshot.role.archived) return false;
  if(Object.hasOwn(ADMIN_PERMISSIONS,permission)) {
    if(!(snapshot.member.is_owner||snapshot.role.permissions.includes(permission)))return false;
    // Governance is organization-wide when no company is supplied. A scoped
    // connection action must still respect the same company limit as SQL.
    if(companyId===undefined)return true;
    return companyId!==null&&(snapshot.member.all_companies||snapshot.member.company_ids.includes(companyId));
  }
  const module=permission.split('.')[0] as ModuleKey;
  if(!snapshot.member.modules.includes(module)||!snapshot.role.permissions.includes(permission)) return false;
  // An omitted company is only a capability check; resource reads must supply an ID (or null).
  if(companyId===undefined) return true;
  if(companyId===null) return false;
  return snapshot.member.all_companies||snapshot.member.company_ids.includes(companyId);
}
export function accessSummary(member:Pick<AccessMember,'all_companies'|'company_ids'|'modules'|'status'>,role:Pick<AccessRole,'name'|'permissions'>):string {
  if(member.status==='suspended') return 'Access is suspended. Previous work stays with the team.';
  const modules=member.modules.map(m=>MODULES[m]).join(', ')||'No financial modules';
  const scope=member.all_companies?'all companies, including future companies':`${member.company_ids.length} selected companies`;
  const posting=member.modules.some(m=>role.permissions.includes(`${m}.post`));
  return `${role.name} · ${modules} · ${scope}. ${posting?'Can post where the role permits.':'Cannot post to ERP.'}`;
}
