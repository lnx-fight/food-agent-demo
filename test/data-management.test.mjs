import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {backupDatabase,restoreDatabase,verifyDatabase} from '../scripts/manage-data.mjs';

test('在线WAL数据库可备份、校验并恢复到新目录，绝不覆盖现有数据',()=>{
  const root=mkdtempSync(join(tmpdir(),'xiaofan-backup-')),db=new DatabaseSync(join(root,'nutrition.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE users(name TEXT); CREATE TABLE foods(name TEXT); CREATE TABLE accounts(id TEXT); CREATE TABLE account_sessions(token_hash TEXT)');
  db.prepare('INSERT INTO users VALUES(?)').run('before backup');
  db.prepare('INSERT INTO account_sessions VALUES(?)').run('old-session-hash');
  const backup=backupDatabase(root,join(root,'backups'));
  if(process.platform!=='win32')assert.equal(statSync(backup).mode&0o777,0o600);
  db.prepare('INSERT INTO users VALUES(?)').run('after backup');
  const target=restoreDatabase(backup,join(root,'restored')),restored=new DatabaseSync(target);
  assert.deepEqual(restored.prepare('SELECT name FROM users').all().map(row=>row.name),['before backup']);assert.equal(restored.prepare('SELECT COUNT(*) n FROM account_sessions').get().n,0);restored.close();
  assert.throws(()=>restoreDatabase(backup,join(root,'restored')),/拒绝覆盖/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,2);db.close();
  const invalid=join(root,'invalid.sqlite'),bad=new DatabaseSync(invalid);bad.exec('CREATE TABLE unrelated(id INTEGER)');bad.close();
  assert.throws(()=>verifyDatabase(invalid),/缺少数据表/);
  assert.throws(()=>backupDatabase(join(root,'missing'),join(root,'backups')),/不存在/);
});
