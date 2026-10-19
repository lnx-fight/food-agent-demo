import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync,chmodSync,copyFileSync,constants,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
export function verifyDatabase(path){
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('数据库完整性校验失败');
    for(const name of ['users','authoritative_foods','accounts','account_sessions'])if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name))throw new Error(`备份缺少数据表：${name}`);
  }finally{db.close()}
}
export function backupDatabase(dataDirectory,backupDirectory){
  const source=join(resolve(dataDirectory),'nutrition.sqlite');
  if(!existsSync(source))throw new Error('数据库不存在，未创建空备份');
  mkdirSync(backupDirectory,{recursive:true,mode:0o700});
  const target=join(resolve(backupDirectory),`xiaofan-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.sqlite`);
  const db=new DatabaseSync(source,{readOnly:true});
  try{db.exec('PRAGMA busy_timeout=10000');db.prepare('VACUUM INTO ?').run(target)}finally{db.close()}
  chmodSync(target,0o600);verifyDatabase(target);return target;
}
export function restoreDatabase(backup,newDirectory){
  verifyDatabase(backup);const targetDirectory=resolve(newDirectory),target=join(targetDirectory,'nutrition.sqlite');
  if(existsSync(target)||existsSync(target+'-wal')||existsSync(target+'-shm'))throw new Error('目标已有数据库文件；为保护现有记录，拒绝覆盖。请使用新的空目录');
  mkdirSync(targetDirectory,{recursive:true,mode:0o700});copyFileSync(realpathSync(backup),target,constants.COPYFILE_EXCL);chmodSync(target,0o600);verifyDatabase(target);
  const restored=new DatabaseSync(target);try{restored.exec('DELETE FROM account_sessions')}finally{restored.close()}
  return target;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [command,...args]=process.argv.slice(2);
  try{
    if(command==='backup')console.log(backupDatabase(process.env.DATA_DIR||join(root,'data'),args[0]||join(root,'backups')));
    else if(command==='restore'&&args.length===2)console.log(restoreDatabase(args[0],args[1]));
    else throw new Error('用法：npm run data:backup -- [备份目录] 或 npm run data:restore -- <备份文件> <新的数据目录>');
  }catch(error){console.error(error.message);process.exitCode=1}
}
