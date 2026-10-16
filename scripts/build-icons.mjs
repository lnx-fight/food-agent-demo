import sharp from 'sharp';
import {writeFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url),source=new URL('assets/xiaofan-avatar.png',root);
const png=async size=>sharp(source.pathname).resize(size,size,{fit:'cover'}).png({compressionLevel:9}).toBuffer();
for(const [name,size] of [['xiaofan-icon.png',512],['icon-192.png',192],['apple-touch-icon.png',180],['favicon-32.png',32]])await writeFile(new URL(name,root),await png(size));

// ICO supports PNG frames; include the native favicon sizes without another encoder.
const sizes=[16,32,48],frames=await Promise.all(sizes.map(png));
const directory=Buffer.alloc(6+16*frames.length);
directory.writeUInt16LE(1,2);directory.writeUInt16LE(frames.length,4);
let offset=directory.length;
for(let index=0;index<frames.length;index++){
  const position=6+index*16;
  directory[position]=sizes[index];directory[position+1]=sizes[index];
  directory.writeUInt16LE(1,position+4);directory.writeUInt16LE(32,position+6);
  directory.writeUInt32LE(frames[index].length,position+8);directory.writeUInt32LE(offset,position+12);
  offset+=frames[index].length;
}
await writeFile(new URL('favicon.ico',root),Buffer.concat([directory,...frames]));
console.log('Brand icon, Apple touch icon, PWA icon and multi-size favicon generated.');
