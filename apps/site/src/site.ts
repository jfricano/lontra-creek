import site from "../package.json" with { type: "json" };

/** The StreamOtter release this site describes and its demo runs: the exact version the site installs. */
export const RELEASE = site.dependencies.streamotter;

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
    summary: "Borrow an isolated bench for five minutes. Cut the relay, stall a laptop, restart the gateway, or foul a sensor, and follow each record through the gateway. The Source failures track also lists the quarantine exercises that wait for StreamOtter V1.1.",
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
    summary: "Every failure mode in this release: the state it produces, the error your code receives, whether it retries, and how to handle it. Plus the source-failure policies planned for V1.1, marked as planned.",
    ready: true
  },
  {
    href: "/docs/",
    label: "Docs",
    question: "How do I build with it?",
    summary: "The guides and the V1 reference, where they're maintained: on GitHub and npm.",
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
