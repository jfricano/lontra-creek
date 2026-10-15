/**
 * Pup Patrol's origin switch: `GAME_ORIGIN`, read by both demo-host processes so one setting
 * turns the game on or off everywhere.
 *
 * - The field station (server/config.ts) answers the game's three /api routes only for it.
 * - The gateway's handlers (kafka-handlers.ts) refuse socket handshakes from the game's origin
 *   unless it is switched on.
 *
 * The gateway's `allowedOrigins` comes from streamotter.production.json, which is baked into
 * the image and always lists GAME_ORIGIN (project.ts). So in production the switch is either
 * exactly that origin or off: any other value would open /api to an origin whose sockets the
 * gateway refuses. Unset or empty is off.
 *
 * Development has no Caddy and no baked config; it defaults to the game's Vite dev server.
 */
import { GAME_DEV_ORIGINS, GAME_ORIGIN } from "./project.ts";

export function gameOrigins(env: NodeJS.ProcessEnv, production: boolean): string[] {
  const raw = env["GAME_ORIGIN"];
  if (production) {
    const value = (raw ?? "").trim();
    if (value === "") return [];
    if (value !== GAME_ORIGIN) throw new Error(`GAME_ORIGIN must be ${GAME_ORIGIN} (the game origin the gateway's baked config allows) or empty in production; got ${JSON.stringify(raw)}.`);
    return [value];
  }
  return (raw ?? GAME_DEV_ORIGINS.join(",")).split(",").map(item => item.trim()).filter(item => item !== "");
}

/**
 * Origins the gateway's config allows but this deployment has switched off: the handlers
 * refuse their handshakes. Only production has one (the game, while GAME_ORIGIN is off).
 */
export function refusedGameOrigins(env: NodeJS.ProcessEnv, production: boolean): string[] {
  return production && gameOrigins(env, production).length === 0 ? [GAME_ORIGIN] : [];
}
