/**
 * The creek behind the live panel. The water always moves: the source keeps
 * running whether or not this page is connected. Its speed follows LC-02's real
 * flow, rain falls when the field station reports rain, and night darkens it.
 * A bright capsule carries each real update over its last stretch into the
 * gateway; the card changes when it arrives.
 */

export interface Lane {
  label: string;
  /** Position across the channel, -1 (left bank) to 1 (right bank). */
  offset: number;
}

export interface Conditions {
  /** Current flow relative to baseflow. */
  flowRatio: number;
  weather: "clear" | "rain" | "storm";
  daylight: "dawn" | "day" | "dusk" | "night";
}

interface Capsule {
  lane: number;
  s: number;
  speed: number;
  arrive: () => void;
}

const LINE_COUNT = 11;
const GATE_INSET = 20;

export class CreekCanvas {
  private readonly context: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private band: Path2D | null = null;
  private edges: Path2D[] = [];
  private lines: { path: Path2D; dash: number[]; speed: number; color: string }[] = [];
  private capsules: Capsule[] = [];
  private rain: { x: number; y: number; length: number }[] = [];
  private flow = 0;
  private conditions: Conditions = { flowRatio: 1, weather: "clear", daylight: "day" };
  private running = false;
  private frame = 0;
  private last = 0;
  private readonly reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly lanes: readonly Lane[]) {
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas unavailable");
    this.context = context;
    new ResizeObserver(() => this.resize()).observe(canvas);
    new IntersectionObserver(entries => this.setVisible(entries.some(entry => entry.isIntersecting))).observe(canvas);
    document.addEventListener("visibilitychange", () => this.setVisible(!document.hidden));
    this.resize();
  }

  setConditions(conditions: Conditions): void {
    this.conditions = conditions;
    if (this.reduced) this.draw();
  }

  /** Carries one update into the gateway, then runs `arrive`. Reduced motion skips the trip. */
  launch(lane: number, arrive: () => void): void {
    if (this.reduced || !this.running) {
      arrive();
      return;
    }
    this.capsules.push({ lane, s: 0.55, speed: 0.95 + Math.random() * 0.2, arrive });
  }

  private setVisible(visible: boolean): void {
    const shouldRun = visible && !document.hidden && !this.reduced;
    if (shouldRun === this.running) return;
    this.running = shouldRun;
    if (shouldRun) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(now => this.tick(now));
    } else {
      cancelAnimationFrame(this.frame);
      // Deliver anything still in flight rather than holding it.
      for (const capsule of this.capsules.splice(0)) capsule.arrive();
    }
  }

  private gate(): number {
    return this.width - GATE_INSET;
  }

  private centre(x: number): number {
    return this.height * 0.5 + this.height * 0.12 * Math.sin((x / Math.max(this.width, 1)) * Math.PI * 1.7 + 0.8);
  }

  private halfWidth(x: number): number {
    return this.height * (0.26 + 0.07 * (x / Math.max(this.width, 1)));
  }

  private strip(offset: number): Path2D {
    const path = new Path2D();
    for (let x = -12; x <= this.gate() + 2; x += 6) {
      const y = this.centre(x) + offset * this.halfWidth(x);
      if (x === -12) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    return path;
  }

  private point(offset: number, s: number): [number, number] {
    const x = s * this.gate();
    return [x, this.centre(x) + offset * this.halfWidth(x)];
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const band = new Path2D();
    for (let x = -12; x <= this.gate(); x += 6) {
      const y = this.centre(x) - this.halfWidth(x);
      if (x === -12) band.moveTo(x, y);
      else band.lineTo(x, y);
    }
    for (let x = this.gate(); x >= -12; x -= 6) band.lineTo(x, this.centre(x) + this.halfWidth(x));
    band.closePath();
    this.band = band;
    this.edges = [this.strip(-1), this.strip(1)];
    this.lines = Array.from({ length: LINE_COUNT }, (_, i) => {
      const offset = -0.84 + (1.68 * i) / (LINE_COUNT - 1);
      return {
        path: this.strip(offset),
        dash: [16 + ((i * 37) % 44), 16 + ((i * 23) % 36)],
        // Water runs fastest mid-channel.
        speed: 30 + 70 * (1 - Math.abs(offset)),
        color: i % 3 === 0 ? "rgba(255, 255, 255, 0.72)" : "rgba(1, 225, 252, 0.6)"
      };
    });
    this.rain = Array.from({ length: 70 }, () => ({ x: Math.random() * this.width, y: Math.random() * this.height, length: 8 + Math.random() * 10 }));
    this.draw();
  }

  private tick(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const pace = Math.min(3, Math.max(0.7, this.conditions.flowRatio));
    this.flow += dt * pace;
    for (const capsule of this.capsules) capsule.s += dt * capsule.speed;
    const arrived = this.capsules.filter(capsule => capsule.s >= 1);
    this.capsules = this.capsules.filter(capsule => capsule.s < 1);
    for (const capsule of arrived) capsule.arrive();
    if (this.conditions.weather !== "clear") {
      const fall = this.conditions.weather === "storm" ? 520 : 340;
      for (const drop of this.rain) {
        drop.y += dt * fall;
        drop.x -= dt * fall * 0.18;
        if (drop.y > this.height) {
          drop.y = -drop.length;
          drop.x = Math.random() * (this.width + 60);
        }
      }
    }
    this.draw();
    if (this.running) this.frame = requestAnimationFrame(next => this.tick(next));
  }

  private draw(): void {
    const c = this.context;
    c.clearRect(0, 0, this.width, this.height);
    if (this.band === null) return;

    const water = c.createLinearGradient(0, 0, 0, this.height);
    const muddy = Math.min(1, Math.max(0, (this.conditions.flowRatio - 1.2) / 1.5));
    water.addColorStop(0, mix("#0b63c4", "#4a6d86", muddy * 0.55));
    water.addColorStop(1, mix("#012e66", "#2e3f4c", muddy * 0.55));
    c.fillStyle = water;
    c.fill(this.band);

    c.lineCap = "round";
    c.strokeStyle = "rgba(92, 203, 255, 0.35)";
    c.lineWidth = 12;
    this.edges.forEach(edge => c.stroke(edge));
    c.strokeStyle = "#1aa7ff";
    c.lineWidth = 3;
    this.edges.forEach(edge => c.stroke(edge));

    c.lineWidth = 3.4;
    for (const line of this.lines) {
      c.setLineDash(line.dash);
      c.lineDashOffset = -this.flow * line.speed;
      c.strokeStyle = line.color;
      c.stroke(line.path);
    }
    c.setLineDash([]);

    for (const capsule of this.capsules) {
      const offset = this.lanes[capsule.lane]?.offset ?? 0;
      const [x1, y1] = this.point(offset, Math.max(0, capsule.s - 0.04));
      const [x2, y2] = this.point(offset, capsule.s);
      c.save();
      c.shadowColor = "#01e1fc";
      c.shadowBlur = 16;
      c.strokeStyle = "#effeff";
      c.lineWidth = 6;
      c.beginPath();
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
      c.stroke();
      c.restore();
    }

    c.font = "600 11px 'JetBrains Mono Variable', ui-monospace, monospace";
    c.textBaseline = "middle";
    this.lanes.forEach(lane => {
      const [x, y] = this.point(lane.offset, 0.035);
      c.fillStyle = "rgba(2, 16, 42, 0.74)";
      c.beginPath();
      c.roundRect(x - 4, y - 10, c.measureText(lane.label).width + 14, 20, 6);
      c.fill();
      c.fillStyle = "#cff8ff";
      c.fillText(lane.label, x + 3, y + 0.5);
    });

    const gx = this.gate() + 6;
    const gh = this.height * 0.74;
    const gy = (this.height - gh) / 2;
    c.save();
    c.shadowColor = "#01e1fc";
    c.shadowBlur = 18;
    c.fillStyle = "#01e1fc";
    c.beginPath();
    c.roundRect(gx - 5, gy, 10, gh, 5);
    c.fill();
    c.restore();
    c.fillStyle = "rgba(207, 248, 255, 0.85)";
    c.textAlign = "right";
    c.textBaseline = "alphabetic";
    c.font = "600 10px 'JetBrains Mono Variable', ui-monospace, monospace";
    c.fillText("GATEWAY", gx + 5, gy - 9);
    c.textAlign = "left";

    if (this.conditions.weather !== "clear") {
      c.strokeStyle = this.conditions.weather === "storm" ? "rgba(200, 230, 255, 0.55)" : "rgba(200, 230, 255, 0.35)";
      c.lineWidth = 1.2;
      c.beginPath();
      for (const drop of this.rain) {
        c.moveTo(drop.x, drop.y);
        c.lineTo(drop.x - drop.length * 0.18, drop.y + drop.length);
      }
      c.stroke();
    }

    const shade = { dawn: 0.12, day: 0, dusk: 0.18, night: 0.38 }[this.conditions.daylight];
    if (shade > 0) {
      c.fillStyle = `rgba(2, 6, 20, ${shade})`;
      c.fillRect(0, 0, this.width, this.height);
    }
  }
}

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i]! - v) * t)).join(", ")})`;
}
