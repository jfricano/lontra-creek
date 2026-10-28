import installed from "streamotter/package.json" with { type: "json" };

/**
 * The StreamOtter release this site describes and its demo runs: the version the site
 * installs, read from the installed package. A test holds it equal to the exact pin.
 */
export const RELEASE: string = installed.version;

/**
 * The install command the site shows. Pinned to the exact release, because an unversioned
 * `npm install streamotter` installs npm's `latest` tag, which need not be this release.
 */
export const INSTALL_COMMAND = `npm install streamotter@${RELEASE}`;

/**
 * StreamOtter's headline: the home page's h1, the footer, and the link cards. The README,
 * npm, and launch posts open with the longer positioning line instead: "Kafka state in the
 * browser that's either live or visibly stale, never silently wrong."
 */
export const TAGLINE = "Live state from Kafka to the browser. Never silently wrong.";

export const SITE = {
  /**
   * False until the public launch. While false, every page is listed, placeholders
   * included, so reviewers can reach them; once true, only pages whose real content
   * exists appear in the navigation, the footer, and the 404 page.
   */
  launched: false,
  /**
   * The site's own milestone and where it stands. It is independent of StreamOtter's
   * milestones and npm versions: site V1.1 is not StreamOtter V1.1 or package 1.1.0.
   */
  milestone: { name: "V1.1", state: "in development" }
};

/** The StreamOtter repository tag for this release, so library links survive its later commits. */
const STREAMOTTER_TAG = `v${RELEASE}`;

export const LINKS = {
  github: "https://github.com/jfricano/StreamOtter",
  npm: "https://www.npmjs.com/package/streamotter",
  guides: `https://github.com/jfricano/StreamOtter/tree/${STREAMOTTER_TAG}/docs/guides`,
  gettingStarted: `https://github.com/jfricano/StreamOtter/blob/${STREAMOTTER_TAG}/docs/guides/getting-started.md`,
  status: `https://github.com/jfricano/StreamOtter/blob/${STREAMOTTER_TAG}/docs/IMPLEMENTATION_STATUS.md`,
  changelog: `https://github.com/jfricano/StreamOtter/blob/${STREAMOTTER_TAG}/CHANGELOG.md`,
  demoRepo: "https://github.com/jfricano/lontra-creek"
} as const;

export interface Page {
  href: string;
  label: string;
  question: string;
  summary: string;
  /** False until the page's real content exists. */
  ready: boolean;
}

export const PAGES: readonly Page[] = [
  {
    href: "/field-station/",
    label: "Field station",
    question: "What does it look like running?",
    summary: "A guided walk down Lontra Creek in six short chapters: first light, a storm, a canyon with no signal, a protected den, a new person on the tablet, and your own sighting.",
    ready: true
  },
  {
    href: "/lab/",
    label: "Failure Lab",
    question: "What happens when it breaks?",
    summary: "Borrow an isolated bench for five minutes. Cut the relay, stall a laptop, restart the gateway, or foul a sensor, and follow each record through the gateway. The Source failures section lists the quarantine exercises and whether this demo's backend can run each one.",
    ready: true
  },
  {
    href: "/playground/",
    label: "Playground",
    question: "What's it like to set up?",
    summary: "Edit a streamotter.json and get the real validator's messages as you type, with nothing to install.",
    ready: true
  },
  {
    href: "/workbench/",
    label: "Workbench",
    question: "What tools do I get?",
    summary: "A tour of the local workbench: Connect, Define, Preview, Inspect, and Export.",
    ready: true
  },
  {
    href: "/when-it-breaks/",
    label: "When it breaks",
    question: "How does it fail, exactly?",
    summary: "What a view's state tells you when something fails, one failure seen from both sides, and how to handle state and errors. The failure reference beside it has every error code and the opt-in source-failure policies.",
    ready: true
  },
  {
    href: "/docs/",
    label: "Docs",
    question: "How do I build with it?",
    summary: "The guides and the API reference, where they're maintained: on GitHub and npm.",
    ready: true
  },
  {
    href: "/releases/",
    label: "Releases",
    question: "What works in this version?",
    summary: "The site release, the exact StreamOtter package it installs, what the demo can run today, and the verified boundary, each stated separately.",
    ready: true
  }
];

/** The pages the navigation, the footer, and the 404 page offer: all of them before launch, then only ready ones. */
export const LISTED_PAGES: readonly Page[] = SITE.launched ? PAGES.filter(page => page.ready) : PAGES;

/**
 * Reference pages outside the main navigation: each is linked from the page it belongs to,
 * and listed in the footer, the 404 page, and the sitemap, after the main pages.
 */
export const REFERENCE_PAGES: readonly Page[] = [
  {
    href: "/failure-reference/",
    label: "Failure reference",
    question: "What does each failure do, exactly?",
    summary: "Every error code in this release, and the opt-in source-failure policies: the failure-policy matrix, record disposition step by step, and the operator commands.",
    ready: true
  }
];

/** The reference pages the footer and the 404 page offer, by the same rule as LISTED_PAGES. */
export const LISTED_REFERENCE_PAGES: readonly Page[] = SITE.launched ? REFERENCE_PAGES.filter(page => page.ready) : REFERENCE_PAGES;
