/** Capture only the pinned npm workbench, never a library checkout. Requires QA's Playwright dependency. */
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
const require=createRequire(import.meta.url);
const cli=join(dirname(require.resolve("streamotter/package.json")),"bin/streamotter.js");
const scratch=mkdtempSync(join(tmpdir(),"lontra-workbench-"));
const out=resolve("apps/site/public/recordings/workbench");mkdirSync(out,{recursive:true});
execFileSync(process.execPath,[cli,"init",scratch]);
const configPath=join(scratch,"streamotter.json");const config=JSON.parse(readFileSync(configPath,"utf8"));config.projectId="workbench-tour";config.gateway.port=7790;writeFileSync(configPath,JSON.stringify(config,null,2));
const child=spawn(process.execPath,[cli,"dev","--config",configPath,"--handlers",join(scratch,"server/handlers.mjs"),"--management-port","7791"]);
let output="";child.stdout.on("data",d=>output+=d);child.stderr.on("data",d=>output+=d);
let browser;
try {
  for(let i=0;i<100&&!output.includes("Token");i++)await new Promise(r=>setTimeout(r,100));
  const token=output.match(/Token\s+(\S+)/)?.[1];if(!token)throw Error("Workbench did not start; check ports 7790/7791.");
  browser=await chromium.launch(process.env.CHROMIUM ? {executablePath:process.env.CHROMIUM} : {});
  const context=await browser.newContext({viewport:{width:1280,height:900},recordVideo:{dir:join(scratch,"video"),size:{width:1280,height:900}}});
  const page=await context.newPage();await page.goto("http://127.0.0.1:7791");
  await page.getByLabel("Management token").fill(token);await page.getByRole("button",{name:"Open workbench",exact:true}).click();
  await page.getByRole("heading",{name:"Connect",exact:true}).waitFor();
  const capture=async name=>{await page.waitForTimeout(1200);await page.screenshot({path:join(out,`${name}.png`),fullPage:true});};
  await capture("connect");
  await page.getByRole("tab",{name:"Define",exact:true}).click();await capture("define");
  await page.getByRole("tab",{name:"Preview",exact:true}).click();await page.getByPlaceholder("value",{exact:true}).fill("job_1");await page.getByRole("button",{name:"Start preview",exact:true}).click();await page.getByText("live",{exact:true}).first().waitFor();await capture("preview");
  await page.getByRole("tab",{name:"Connect",exact:true}).click();await page.getByRole("button",{name:"Advance fixture",exact:true}).click();
  await page.getByRole("tab",{name:"Preview",exact:true}).click();await capture("updated");
  await page.getByRole("tab",{name:"Inspect",exact:true}).click();await capture("inspect");
  await page.getByRole("tab",{name:"Export",exact:true}).click();await capture("export");
  const video=page.video();await context.close();await video.saveAs(join(out,"tour.webm"));
  const manifest={version:require("streamotter/package.json").version,capturedAt:new Date().toISOString(),source:"Published npm workbench; CLI-generated fixture project on loopback",viewport:{width:1280,height:900},node:process.version,steps:["Connect: inspect the fixture source","Define: inspect the channel and schemas","Preview: subscribe to job_1 as developer","Connect: advance one real fixture record","Preview: inspect the updated state","Inspect: read payload-free trace metadata","Export: review the export controls"]};
  writeFileSync(join(out,"capture.json"),JSON.stringify(manifest,null,2)+"\n");
  console.log(`Captured workbench ${manifest.version}: six images, recorded session, and provenance.`);
} finally {await browser?.close();child.kill("SIGTERM");await new Promise(r=>child.once("exit",r));rmSync(scratch,{recursive:true,force:true});}
