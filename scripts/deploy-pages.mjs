import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import project from '../cloudflare/project.json' with {type:'json'};

if(!process.env.CLOUDFLARE_API_TOKEN)throw new Error('CLOUDFLARE_API_TOKEN is required; use the scoped Pages + D1 deployment token.');
const env={...process.env,CLOUDFLARE_ACCOUNT_ID:project.accountId,WRANGLER_SEND_METRICS:'false'};
const npx=process.platform==='win32'?'npx.cmd':'npx';
// cf beta.17 explicitly delegates legacy Pages uploads to Wrangler. All
// resource configuration and D1 migrations use cf; no Wrangler config is used.
const args=['--yes',`wrangler@${project.pagesUploaderVersion}`,'pages','deploy','dist','--project-name',project.projectName,'--branch',project.productionBranch,'--commit-dirty=true','--no-bundle'];
if(process.env.GITHUB_SHA)args.push('--commit-hash',process.env.GITHUB_SHA);
const result=spawnSync(npx,args,{stdio:'inherit',env});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
// Verify the deployed API and D1 binding, including the expected data snapshot.
const manifest=JSON.parse(readFileSync(new URL('../data/tfda/manifest.json',import.meta.url),'utf8'));
const url=`https://${project.projectName}.pages.dev/api/health`;
let failure;
for(let attempt=0;attempt<12;attempt++){
  try{
    const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(15000)}),data=await response.json();
    if(!response.ok||data.ok!==true||data.foodCount!==0||data.nutritionSource!=='TFDA'||data.authoritativeFoodCount!==manifest.totalRows||data.nutrientRecordCount!==manifest.nutrientRows)throw new Error(`Health check failed: HTTP ${response.status}`);
    console.log(`Verified ${url}: Retired Chinese foods=${data.foodCount}, TFDA foods=${data.authoritativeFoodCount}, nutrient records=${data.nutrientRecordCount}`);
    failure=null;break;
  }catch(error){failure=error;await new Promise(resolve=>setTimeout(resolve,5000))}
}
if(failure)throw failure;
