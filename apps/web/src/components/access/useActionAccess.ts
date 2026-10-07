'use client';
import {useCallback} from 'react';
import {canAccess} from '@autodealer/shared/lib/access';
import {useAccess} from './AccessProvider';
/** Presentation only. Backend resource checks remain authoritative. */
export function useActionAccess(companyId?:string|null) {
 const {snapshot,enforcementRequired}=useAccess();
 return useCallback((permission:string)=>!enforcementRequired||Boolean(snapshot&&companyId&&canAccess(snapshot,permission,companyId)),[snapshot,enforcementRequired,companyId]);
}
