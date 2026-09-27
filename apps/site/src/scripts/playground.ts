import { installTabletNetwork } from "./tablet-network.ts";
// Vite may share contracts with the SDK chunk; install the transport shim first.
installTabletNetwork();
const editor=document.querySelector<HTMLTextAreaElement>("#config-editor")!;
const status=document.querySelector<HTMLElement>("#validation-status")!;
const issues=document.querySelector<HTMLElement>("#validation-issues")!;
const original=editor.value;
let timer:ReturnType<typeof setTimeout>;
// Split at the page boundary: no other route loads the validator.
void import("streamotter/contracts").then(({validateProjectConfig})=>{
  const validate=()=>{
    issues.replaceChildren();
    try {
      const result=validateProjectConfig(JSON.parse(editor.value));
      status.textContent=result.valid ? "Valid configuration. No connections or handlers were run." : `${result.issues.length} validation issue(s).`;
      for(const issue of result.issues){const li=document.createElement("li");li.textContent=`${issue.path}: ${issue.message} (${issue.code})`;issues.append(li);}
    }catch {status.textContent="Invalid JSON. Check commas, braces, and quoted property names.";}
  };
  editor.addEventListener("input",()=>{clearTimeout(timer);timer=setTimeout(validate,250);});
  document.querySelector("#reset-config")!.addEventListener("click",()=>{editor.value=original;validate();});
  validate();
}).catch(()=>{status.textContent="The validator could not load. Reload this page to try again.";});
const connect=document.querySelector<HTMLButtonElement>("#console-connect")!;
const close=document.querySelector<HTMLButtonElement>("#console-close")!;
const consoleStatus=document.querySelector<HTMLElement>("#console-status")!;
const log=document.querySelector<HTMLElement>("#console-log")!;
let field:import("./field-client.ts").FieldClient|null=null;
let generation=0;
let idle:ReturnType<typeof setTimeout>|undefined;
const scheduleIdle=()=>{clearTimeout(idle);if(field)idle=setTimeout(()=>{void disconnect().then(()=>{consoleStatus.textContent="Console paused after 10 minutes idle. Connect to resume.";});},10*60*1000);};
for(const event of ["pointerdown","keydown"])document.addEventListener(event,scheduleIdle,{passive:true});
document.addEventListener("visibilitychange",scheduleIdle);
const rows:string[]=[];
const append=(text:string)=>{rows.unshift(text);rows.splice(40);log.textContent=rows.join("\n");};
const disconnect=async()=>{clearTimeout(idle);generation++;const active=field;field=null;await active?.close();connect.disabled=false;close.disabled=true;consoleStatus.textContent="Disconnected.";};
connect.addEventListener("click",async()=>{
  const attempt=++generation;connect.disabled=true;consoleStatus.textContent="Connecting…";
  try {
    const {openFieldClient}=await import("./field-client.ts");
    const active=await openFieldClient();
    if(attempt!==generation){await active.close();return;}
    field=active;scheduleIdle();close.disabled=false;consoleStatus.textContent=active.sourceLabel;
    const view=active.watch("station",{stationId:"LC-02"});
    view.on("state",event=>{consoleStatus.textContent=`${active.sourceLabel} · ${event.state}`;append(`state ${event.state}${event.reason ? ` / ${event.reason}` : ""}`);});
    view.on("data",({event,revision})=>append(`${event.kind} revision ${revision}\n${JSON.stringify(event.data)}`));
    view.on("error",error=>append(`error ${error.code}`));
    active.on("unreachable",()=>{consoleStatus.textContent="Field station unavailable. Disconnect and try again later.";});
  }catch {if(attempt===generation){consoleStatus.textContent="Field station unavailable. Try again later or run the demo locally.";connect.disabled=false;}}
});
close.addEventListener("click",()=>{void disconnect();});
window.addEventListener("pagehide",()=>{void disconnect();});

export {};
