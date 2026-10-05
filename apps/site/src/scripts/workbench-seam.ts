/**
 * The published workbench this site mounts on /workbench/, once a StreamOtter release
 * provides one (WHC-1, sandbox contract §4). Null until then: the installed
 * `@streamotter/workbench@0.1.0-rc.3` ships no `workbench-host.json`, so there is
 * nothing to mount, and the page never stands in for it. The slice that pins the
 * first release with the seam (W9a) fills this in from that release's manifest and
 * serves its `dist/` files at `script` and `style`; test/workbench-seam.test.ts keeps
 * the two in step.
 */
export interface PublishedSeam {
  package: "@streamotter/workbench";
  /** The exact pinned version; the sandbox service must report the same one. */
  version: string;
  hostContract: 1;
  /** Where the site serves the manifest's entry files. */
  script: string;
  style: string;
  /** The manifest's sha384 values for app.js and styles.css. */
  integrity: { script: string; style: string };
}

export const PUBLISHED_SEAM: PublishedSeam | null = null;
