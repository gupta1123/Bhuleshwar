import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pagePermissions} from './access-routes.ts';
import {DEFAULT_ROLES,canAccess} from './access.ts';
test('direct financial navigation has explicit module permissions',()=>{
 for(const [path,permission] of [['/cases/x/mismatches','purchases.view'],['/workspace','purchases.prepare'],['/bank-statements','bank.view'],['/collections','discounts.view'],['/collections/follow-ups','followups.view'],['/tally-prime?view=connection','connections.manage']])assert.deepEqual(pagePermissions(path),[permission]);
 assert.deepEqual(pagePermissions('/settings/team'),['team.manage','roles.manage']);
});
test('default-role financial permission matrix, suspension and unclassified records',()=>{
 for(const role of DEFAULT_ROLES){
  const s={member:{status:'active',must_change_password:false,is_owner:false,all_companies:false,company_ids:['a'],modules:['purchases','bank','discounts','followups']},role:{...role,archived:false}};
  for(const module of s.member.modules)for(const action of ['view','prepare','submit','approve','post','export','recycle','delete']){
   const permission=`${module}.${action}`;
   assert.equal(canAccess(s,permission,'a'),role.permissions.includes(permission));
   assert.equal(canAccess(s,permission,'b'),false);
   assert.equal(canAccess(s,permission,null),false);
   assert.equal(canAccess({...s,member:{...s.member,status:'suspended'}},permission,'a'),false);
   assert.equal(canAccess({...s,member:{...s.member,must_change_password:true}},permission,'a'),false);
  }
 }
});
