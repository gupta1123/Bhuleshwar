import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,['--test','apps/api/src/lib/processing/packet-regressions.test.mjs'],{stdio:'inherit',cwd:new URL('../',import.meta.url)});
process.exitCode=result.status??1;
