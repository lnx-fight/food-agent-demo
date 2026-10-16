import {spawnSync} from 'node:child_process';
import project from '../cloudflare/project.json' with {type:'json'};

const executable=process.platform==='win32'?'cf.cmd':'cf';
const result=spawnSync(executable,['d1','migrations','apply',project.databaseId,'--dir','migrations',...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,CLOUDFLARE_ACCOUNT_ID:project.accountId}});
if(result.error)throw result.error;
process.exitCode=result.status??1;
