/**
 * The published workbench this site mounts on /workbench/ (WHC-1, sandbox contract §4).
 * The literals are copied from the `workbench-host.json` manifest of the installed
 * `@streamotter/workbench@0.2.0-rc.1`, the vendored pre-publish tarball, and the hashes
 * were recomputed from its files. Re-pin them from the published tarball after
 * `npm publish`, when vendor/ gives way to the registry pin: test/workbench-seam.test.ts
 * and the site build (integrations/workbench-assets.mjs) both fail until they match the
 * installed files again. The site serves `entry.script`, `entry.hostStyle` and the
 * license file under a versioned path, so a cached file from an older pin never meets
 * a newer integrity value.
 */
export interface PublishedSeam {
  package: "@streamotter/workbench";
  /** The exact pinned version; the sandbox service must report the same one. */
  version: string;
  hostContract: 1;
  /** Where the site serves the manifest's `entry.script` and `entry.hostStyle`, and the license file that ships with app.js. */
  script: string;
  hostStyle: string;
  licenses: string;
  /** The manifest's sha384 values for `entry.script` and `entry.hostStyle`. */
  integrity: { script: string; hostStyle: string };
}

export const PUBLISHED_SEAM: PublishedSeam | null = {
  package: "@streamotter/workbench",
  version: "0.2.0-rc.1",
  hostContract: 1,
  script: "/workbench/assets/0.2.0-rc.1/app.js",
  hostStyle: "/workbench/assets/0.2.0-rc.1/workbench-host.css",
  licenses: "/workbench/assets/0.2.0-rc.1/THIRD_PARTY_LICENSES.txt",
  integrity: {
    script: "sha384-GWn559rLPV1si0xVPgQN+9UnE/P/+ZESNfsIJTL7PGi1sECWBqS7GD/q+MdFVyhN",
    hostStyle: "sha384-9cVRp8HsDr6BXGJYI8HDSyzga0kJPZmvj4dfBlE6hdYHS5+UomQVxwD3mU+jFU5o"
  }
};
