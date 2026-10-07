import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canAccess,validatePermissions,DEFAULT_ROLES,accessSummary} from './access.ts';
const snapshot={organizationId:'one',member:{status:'active',must_change_password:false,is_owner:false,all_companies:false,company_ids:['a'],modules:['purchases']},role:{archived:false,permissions:['purchases.view','purchases.prepare']}};
test('permission, module and company must all match',()=>{
 assert.equal(canAccess(snapshot,'purchases.prepare','a'),true);
 for(const [p,c] of [['purchases.post','a'],['bank.view','a'],['purchases.view','b'],['purchases.view',null]])assert.equal(canAccess(snapshot,p,c),false);
 assert.equal(canAccess({...snapshot,member:{...snapshot.member,status:'suspended'}},'purchases.view','a'),false);
 assert.equal(canAccess({...snapshot,member:{...snapshot.member,must_change_password:true}},'purchases.view','a'),false);
});
test('owner governance does not grant financial permissions',()=>{
 const owner={...snapshot,member:{...snapshot.member,is_owner:true},role:{...snapshot.role,permissions:[]}};
 assert.equal(canAccess(owner,'team.manage'),true);
 assert.equal(canAccess(owner,'purchases.post','a'),false);
});
test('company-specific administrative authority matches SQL company scope',()=>{
 const owner={...snapshot,member:{...snapshot.member,is_owner:true},role:{...snapshot.role,permissions:[]}};
 assert.equal(canAccess(owner,'connections.manage'),true);
 assert.equal(canAccess(owner,'connections.manage','a'),true);
 assert.equal(canAccess(owner,'connections.manage','b'),false);
 assert.equal(canAccess(owner,'connections.manage',null),false);
});
test('defaults and dependencies are explicit',()=>{
 for(const role of DEFAULT_ROLES){validatePermissions(role.permissions);assert.equal(role.permissions.some(p=>p.endsWith('.post')),false);}
 assert.throws(()=>validatePermissions(['purchases.post']));
 assert.throws(()=>validatePermissions(['purchases.view','purchases.submit']));
 assert.throws(()=>validatePermissions(['unknown.permission']));
 assert.throws(()=>validatePermissions(['purchases.view','purchases.view']));
 assert.match(accessSummary({...snapshot.member,modules:['purchases']},{name:'Operator',permissions:[]}),/Cannot post/);
});
