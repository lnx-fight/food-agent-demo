// Keep multi-statement writes atomic on both SQLite and D1. Statements are
// prepared before entering the batch: D1 does not allow BEGIN/COMMIT over I/O.
export async function atomic(db,statements){
  if(db.isD1)return db.batch(statements);
  db.exec('BEGIN IMMEDIATE');
  try{
    const results=statements.map(([sql,params=[]])=>db.prepare(sql).run(...params));
    db.exec('COMMIT');return results;
  }catch(error){db.exec('ROLLBACK');throw error}
}

export function accountGuard(row,{version=false,session=false}={}){
  const clauses=['id=?','password_hash=?'],params=[row.id,row.password_hash];
  if(version){clauses.push('state_version=?');params.push(row.state_version)}
  if(session){clauses.push('EXISTS(SELECT 1 FROM account_sessions WHERE account_id=accounts.id AND token_hash=? AND expires_at>?)');params.push(row.token_hash,Date.now())}
  return ['INSERT INTO write_guards(ok) VALUES((SELECT COUNT(*) FROM accounts WHERE '+clauses.join(' AND ')+'))',params];
}
export const clearGuard=['DELETE FROM write_guards'];
