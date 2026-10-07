export const LOCAL_USER_ID = "local-dev-user";

export function isLocalDbMode() {
  if(process.env.NODE_ENV==='production'&&process.env.LOCAL_DB_MODE==='true')throw new Error('Local authentication bypass is forbidden in production.');
  return process.env.LOCAL_DB_MODE === "true";
}
