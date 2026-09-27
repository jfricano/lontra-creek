import type { GaugeReading, OtterStatus } from "../generated/streamotter.generated.ts";
import { renderStation, renderOtter } from "./field-cards.ts";
interface Frame { atMs: number; card: number; type: "state" | "data"; change?: { state: string }; event?: { data: GaugeReading | OtterStatus; revision: string; kind: string }; }
interface Recording { recordedAt: string; where: string; durationMs: number; events: Frame[]; }
export async function openRecording(root: HTMLElement): Promise<void> {
  const dialog = root.querySelector<HTMLDialogElement>("[data-recording]");
  if (!dialog) return;
  dialog.showModal();
  const label = dialog.querySelector<HTMLElement>("[data-recording-label]")!;
  const cards = [...dialog.querySelectorAll<HTMLElement>("[data-recorded-card]")];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  dialog.addEventListener("close", () => { stopped = true; clearTimeout(timer); }, { once: true });
  dialog.querySelector<HTMLButtonElement>("[data-recording-close]")!.onclick = () => dialog.close();
  try {
    const response = await fetch("/recordings/creek.json");
    if (!response.ok) throw new Error("Recording unavailable");
    const recording = await response.json() as Recording;
    label.textContent = `Recording · ${recording.recordedAt.slice(0,10)} · ${recording.where}. These are recorded SDK events, not a live connection.`;
    const started = performance.now(); let index = 0;
    const play = (): void => {
      if (stopped) return;
      while (index < recording.events.length && recording.events[index]!.atMs <= performance.now()-started) {
        const frame = recording.events[index++]!; const card = cards[frame.card]; if (!card) continue;
        if (frame.type === "data" && frame.event) {
          if (frame.card === 1) renderOtter(card, frame.event.data as OtterStatus); else renderStation(card, frame.event.data as GaugeReading);
          card.querySelector<HTMLElement>("[data-recorded-rev]")!.textContent = `Recorded revision ${frame.event.revision}`;
        } else if (frame.change) card.querySelector<HTMLElement>("[data-recorded-state]")!.textContent = `Recorded state: ${frame.change.state}`;
      }
      if (index < recording.events.length) timer = setTimeout(play, 50);
      else dialog.querySelector<HTMLElement>("[data-recording-finished]")!.textContent = "Recording complete.";
    };
    dialog.querySelector<HTMLElement>("[data-recording-finished]")!.textContent = "";
    play();
  } catch { label.textContent = "The recording could not be loaded. The live demo is still unavailable; use the local-run instructions."; }
}
