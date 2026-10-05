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
// /workbench/ hosts the published workbench under a meta Content-Security-Policy that allows only
// 'self' scripts and styles (sandbox contract §4), so the built page must have nothing inline.
{
  const route='/workbench/';
  const html=await readFile(join(root,'workbench','index.html'),'utf8');
  const policy=html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1]?.replaceAll('&#39;',"'");
  if(!policy) failures.push(`${route}: no meta Content-Security-Policy`);
  else {
    const directives=new Map(policy.split(';').map(part=>part.trim().split(/\s+/)).map(([name,...sources])=>[name,sources]));
    for(const name of ['default-src','script-src','style-src']) if(directives.get(name)?.join(' ')!=="'self'") failures.push(`${route}: ${name} is not exactly 'self' (${directives.get(name)?.join(' ')})`);
    if(!directives.has('connect-src')) failures.push(`${route}: the policy has no connect-src`);
    if(/unsafe-|frame-ancestors/.test(policy)) failures.push(`${route}: the policy allows unsafe sources or carries frame-ancestors, which a meta policy cannot`);
    const head=html.slice(0,html.indexOf('<meta http-equiv="Content-Security-Policy"'));
    if(/<(?:script|link|style)\b/.test(head)) failures.push(`${route}: something loads before the meta Content-Security-Policy`);
  }
  for(const match of html.matchAll(/<script\b([^>]*)>/g)) {
    const attributes=match[1];
    if(!/\bsrc="/.test(attributes) && !/\btype="application\/json"/.test(attributes)) failures.push(`${route}: inline <script${attributes}>`);
  }
  if(/<style\b/.test(html)) failures.push(`${route}: inline <style>`);
  if(/\sstyle=/.test(html)) failures.push(`${route}: a style= attribute`);
  // The policy allows data: only for images; an inlined font would be refused.
  for(const match of html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)) {
    const css=await readFile(join(root,match[1]),'utf8').catch(()=>'');
    if(/url\(\s*["']?data:(?!image\/)/.test(css)) failures.push(`${route}: ${match[1]} inlines a data: URL the policy refuses`);
  }
}
// Every page, /workbench/ included, is sent the framing and sniffing headers by the site-wide rule.
// Pages joins a header set by two matching rules with ", " (`DENY, DENY` is invalid), so no other rule repeats one.
{
  const headers=await readFile(join(root,'_headers'),'utf8').catch(()=>'');
  const rules=[...headers.matchAll(/^([^#\s]\S*)\n((?:[ \t]+.+\n?)+)/gm)].map(([,path,block])=>[path,block]);
  const site=rules.find(([path])=>path==='/*')?.[1]??'';
  for(const header of ['X-Frame-Options: DENY',"Content-Security-Policy: frame-ancestors 'none'",'X-Content-Type-Options: nosniff']) {
    if(!site.includes(header)) failures.push(`_headers: /* does not send ${header}`);
    const name=header.slice(0,header.indexOf(':'));
    for(const [path,block] of rules) if(path!=='/*' && block.split('\n').some(line=>line.trim().toLowerCase().startsWith(name.toLowerCase()+':'))) failures.push(`_headers: ${path} sets ${name}, which only /* may set`);
  }
}
if(failures.length) {console.error(failures.join('\n'));process.exitCode=1;} else console.log(`Checked ${count} built local links and assets, /workbench/'s policy, and the site-wide headers.`);
