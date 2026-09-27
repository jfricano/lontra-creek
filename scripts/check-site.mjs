/** Validate every built local navigation target and asset without fetching the web. */
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
const root = resolve(import.meta.dirname, '../apps/site/dist');
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes:true });
  return (await Promise.all(entries.map(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]))).flat();
}
const failures=[];
let count=0;
for(const file of (await files(root)).filter(f=>f.endsWith('.html'))) {
  const html=await readFile(file,'utf8');
  const route='/'+relative(root,file).replace(/index\.html$/, '');
  for(const match of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    const raw=match[1].replaceAll('&amp;','&');
    if(!raw || /^(?:https?:|mailto:|tel:|data:|blob:|javascript:)/.test(raw)) continue;
    const url=new URL(raw,'https://local.invalid'+route);
    if(url.origin!=='https://local.invalid') continue;
    let target=resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!target.startsWith(root+'/') && target!==root) {failures.push(`${route}: unsafe target ${raw}`);continue;}
    try {
      const info=await stat(target); if(info.isDirectory())target=join(target,'index.html');
      const data=await readFile(target,'utf8');
      if(url.hash && target.endsWith('.html')) {
        const id=decodeURIComponent(url.hash.slice(1));
        const ids=[...data.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
        // Walkthrough chapter fragments are client-driven steps, each explicitly declared.
        if(!ids.includes(id) && !(/^chapter-[1-6]$/.test(id) && data.includes(`data-chapter="${id.slice(-1)}"`))) failures.push(`${route}: missing anchor ${raw}`);
      }
      count++;
    } catch {failures.push(`${route}: missing ${raw}`);}
  }
}
if(failures.length) {console.error(failures.join('\n'));process.exitCode=1;} else console.log(`Checked ${count} built local links and assets.`);
