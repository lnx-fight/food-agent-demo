// Split migration statements without splitting quoted food names or comments.
export function sqlStatements(source){
  const statements=[];let current='',quote='',lineComment=false,blockComment=false;
  for(let index=0;index<source.length;index++){
    const char=source[index],next=source[index+1];
    if(lineComment){if(char==='\n'){lineComment=false;current+='\n'}continue}
    if(blockComment){if(char==='*'&&next==='/'){blockComment=false;index++;current+=' '}continue}
    if(quote){current+=char;if(char===quote){if(next===quote){current+=next;index++}else quote=''}continue}
    if(char==='-'&&next==='-'){lineComment=true;index++;continue}
    if(char==='/'&&next==='*'){blockComment=true;index++;continue}
    if(char==="'"||char==='"'||char==='`'){quote=char;current+=char;continue}
    if(char===';'){if(current.trim())statements.push(current.trim());current='';continue}
    current+=char;
  }
  if(current.trim())statements.push(current.trim());
  return statements;
}
