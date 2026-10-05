import { PLAYGROUND_PRESETS, presetText } from "../data/playground-presets.ts";
import { watchIdle } from "./idle-session.ts";
import { installTabletNetwork } from "./tablet-network.ts";
// Vite may share contracts with the SDK chunk; install the transport shim first.
installTabletNetwork();
const editor=document.querySelector<HTMLTextAreaElement>("#config-editor")!;
const status=document.querySelector<HTMLElement>("#validation-status")!;
const issues=document.querySelector<HTMLElement>("#validation-issues")!;
const picker=document.querySelector<HTMLSelectElement>("#config-preset")!;
const note=document.querySelector<HTMLElement>("#preset-note")!;
let timer:ReturnType<typeof setTimeout>;
/** Set once the installed validator has loaded; until then a preset only fills the editor. */
let validate:(()=>void)|undefined;
// A preset is only text in the editor: whatever the validator says about it is its own answer.
const load=()=>{const preset=PLAYGROUND_PRESETS.find(entry=>entry.id===picker.value)??PLAYGROUND_PRESETS[0]!;picker.value=preset.id;note.textContent=preset.note;editor.value=presetText(preset);clearTimeout(timer);validate?.();};
picker.addEventListener("change",load);
document.querySelector("#reset-config")!.addEventListener("click",load);
// Split at the page boundary: no other route loads the validator.
void import("streamotter/contracts").then(({validateProjectConfig})=>{
  validate=()=>{
    issues.replaceChildren();
    try {
      const result=validateProjectConfig(JSON.parse(editor.value));
      status.textContent=result.valid ? "Valid configuration. No connections or handlers were run." : `${result.issues.length} validation issue(s).`;
      for(const issue of result.issues){const li=document.createElement("li");li.textContent=`${issue.path}: ${issue.message} (${issue.code})`;issues.append(li);}
    }catch {status.textContent="Invalid JSON. Check commas, braces, and quoted property names.";}
  };
  editor.addEventListener("input",()=>{clearTimeout(timer);timer=setTimeout(validate!,250);});
  validate();
}).catch(()=>{status.textContent="The validator could not load. Reload this page to try again.";});
const connect=document.querySelector<HTMLButtonElement>("#console-connect")!;
const close=document.querySelector<HTMLButtonElement>("#console-close")!;
const consoleStatus=document.querySelector<HTMLElement>("#console-status")!;
const log=document.querySelector<HTMLElement>("#console-log")!;
let field:import("./field-client.ts").FieldClient|null=null;
let generation=0;
let stopIdle: (() => void) | undefined;
const rows:string[]=[];
const append=(text:string)=>{rows.unshift(text);rows.splice(40);log.textContent=rows.join("\n");};
const disconnect=async()=>{stopIdle?.();stopIdle=undefined;generation++;const active=field;field=null;await active?.close();connect.disabled=false;close.disabled=true;consoleStatus.textContent="Disconnected.";};
connect.addEventListener("click",async()=>{
  const attempt=++generation;connect.disabled=true;consoleStatus.textContent="Connecting…";
  try {
    const {openFieldClient}=await import("./field-client.ts");
    const active=await openFieldClient();
    if(attempt!==generation){await active.close();return;}
    field=active;stopIdle=watchIdle(()=>{void disconnect().then(()=>{consoleStatus.textContent="Console paused after 10 minutes idle or hidden. Connect to resume.";});});close.disabled=false;consoleStatus.textContent=active.sourceLabel;
    const view=active.watch("station",{stationId:"LC-02"});
    view.on("state",event=>{consoleStatus.textContent=`${active.sourceLabel} · ${event.state}`;append(`state ${event.state}${event.reason ? ` / ${event.reason}` : ""}`);});
    view.on("data",({event,revision})=>append(`${event.kind} revision ${revision}\n${JSON.stringify(event.data)}`));
    view.on("error",error=>append(`error ${error.code}`));
    active.on("unreachable",()=>{consoleStatus.textContent="Field station unavailable. Disconnect and try again later.";});
  }catch {if(attempt===generation){consoleStatus.textContent="Field station unavailable. Try again later or run the demo locally.";connect.disabled=false;}}
});
close.addEventListener("click",()=>{void disconnect();});
window.addEventListener("pagehide",()=>{void disconnect();});
window.addEventListener("pageshow",event=>{if(event.persisted)void disconnect();});

export {};
