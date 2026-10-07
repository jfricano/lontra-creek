import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { loadApiReference, sourceUrlFor } from "../integrations/api-reference.mjs";
import { buildApiReference, KIND, type ApiReference, type TdProject, type TdReflection } from "../src/api-reference/build.ts";
import { API_MODULES, API_ROOT } from "../src/api-reference/modules.ts";
import { RELEASE } from "../src/site.ts";

/** A TypeDoc-shaped model with every entry point the site documents; `contracts` holds `declared`. */
function model(declared: TdReflection[], extra: Record<string, TdReflection[]> = {}): TdProject {
  let id = 1000;
  return {
    children: API_MODULES.map(module => ({
      id: id++, name: module.entry, kind: KIND.Module,
      children: module.entry === "contracts" ? declared : extra[module.entry] ?? []
    }))
  };
}
const text = (value: string) => ({ summary: [{ kind: "text" as const, text: value }] });
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]!);

describe("buildApiReference", () => {
  test("documents a re-exported symbol once, where it is declared, and lists every path that exports it", () => {
    const reference = buildApiReference(model(
      [{ id: 1, name: "Client", kind: KIND.Interface, comment: text("A client."), children: [] }],
      { client: [{ id: 2, name: "Client", kind: KIND.Reference, target: 1 }] }
    ), { release: "1.2.3" });
    assert.equal(reference.symbols.length, 1);
    const [client] = reference.symbols;
    assert.equal(client!.href, `${API_ROOT}contracts/Client/`);
    assert.deepEqual(client!.importPaths, ["streamotter/contracts", "streamotter/client"]);
    const row = reference.modules.find(module => module.slug === "client")!.exports[0]!;
    assert.deepEqual([row.href, row.reexport, row.summaryText], [client!.href, true, "A client."]);
  });

  test("links references and {@link} tags to their pages, members to their anchors, and leaves outside types plain", () => {
    const reference = buildApiReference(model([
      { id: 1, name: "Options", kind: KIND.Interface, children: [{ id: 3, name: "origin", kind: KIND.Property, type: { type: "intrinsic", name: "string" } }] },
      {
        id: 2, name: "connect", kind: KIND.Function,
        signatures: [{
          id: 4, name: "connect", kind: 4096,
          comment: { summary: [{ kind: "text", text: "Uses " }, { kind: "inline-tag", tag: "@link", text: "Options.origin", target: 3 }, { kind: "text", text: "." }] },
          parameters: [{ id: 5, name: "options", kind: 32768, type: { type: "reference", name: "Options", target: 1 } }],
          type: { type: "reference", name: "Promise", target: { sourceFileName: "lib.d.ts" }, typeArguments: [{ type: "intrinsic", name: "void" }] }
        }]
      }
    ]), { release: "1.2.3" });
    const connect = reference.symbols.find(symbol => symbol.name === "connect")!;
    assert.deepEqual(hrefs(connect.signatures[0]!.codeHtml), [`${API_ROOT}contracts/Options/`]);
    assert.match(connect.signatures[0]!.codeHtml, /: Promise&lt;<span class="kw">void<\/span>&gt;$/);
    assert.deepEqual(hrefs(connect.summaryHtml), [`${API_ROOT}contracts/Options/#member-origin`]);
    assert.equal(connect.summaryText, "Uses Options.origin.");
    assert.equal(reference.symbols.find(symbol => symbol.name === "Options")!.members[0]!.anchor, "member-origin");
  });

  test("escapes names, literals and comments; raw HTML in a comment stays text", () => {
    const reference = buildApiReference(model([{
      id: 1, name: "Tag", kind: KIND.TypeAlias, comment: text("Matches <script>alert(1)</script> & more."),
      type: { type: "literal", value: "</code><img src=x>" }
    }]), { release: "1.2.3" });
    const [tag] = reference.symbols;
    assert.doesNotMatch(tag!.summaryHtml + tag!.codeHtml, /<script|<img/);
    assert.match(tag!.summaryHtml, /&lt;script&gt;/);
    assert.match(tag!.codeHtml!, /&#34;&#60;\/code&#62;&#60;img src=x&#62;&#34;/);
  });

  test("names that differ only in case get distinct paths, the type keeping the bare name", () => {
    const reference = buildApiReference(model([
      { id: 1, name: "streamError", kind: KIND.Function, signatures: [] },
      { id: 2, name: "StreamError", kind: KIND.Interface, children: [] }
    ]), { release: "1.2.3" });
    assert.deepEqual(reference.symbols.map(symbol => symbol.href).sort(), [`${API_ROOT}contracts/StreamError/`, `${API_ROOT}contracts/streamError-function/`]);
  });

  test("a model without one of the documented entry points fails the build", () => {
    assert.throws(() => buildApiReference({ children: [] }, { release: "1.2.3" }), /no client entry point for streamotter\/client/);
  });

  test("source links open the release's source file, not its declaration file", () => {
    const url = sourceUrlFor("1.2.3");
    assert.equal(url("@streamotter/contracts/dist/types.d.ts", 4), "https://github.com/jfricano/StreamOtter/blob/v1.2.3/packages/contracts/src/types.ts");
    assert.equal(url("node_modules/@types/node/http.d.ts", 4), null);
  });
});

describe("the reference for the installed release", () => {
  let reference: ApiReference;
  before(async () => { reference = await loadApiReference(); });

  test("describes the release the site pins", () => {
    assert.equal(reference.release, RELEASE);
  });

  test("every documented import path has exports, and the main entry points are where readers look for them", () => {
    for (const module of reference.modules) assert.ok(module.exports.length > 0, module.importPath);
    const find = (name: string) => reference.symbols.find(symbol => symbol.name === name);
    assert.equal(find("createClient")?.module, "client");
    assert.equal(find("createGateway")?.module, "gateway");
    assert.equal(find("defineProject")?.module, "gateway");
    assert.ok(find("Client")?.importPaths.includes("streamotter/client"));
    // Internal declarations stay out.
    assert.equal(find("GatewayInternals"), undefined);
  });

  test("pages have unique paths, even on a case-insensitive disk, and every link inside them resolves", () => {
    const pages = new Set(reference.symbols.map(symbol => symbol.href));
    assert.equal(pages.size, reference.symbols.length);
    assert.equal(new Set([...pages].map(href => href.toLowerCase())).size, pages.size);
    const anchors = new Set(reference.symbols.flatMap(symbol => symbol.members.map(member => `${symbol.href}#${member.anchor}`)));
    const html = JSON.stringify(reference);
    for (const href of new Set(hrefs(html.replace(/\\"/g, "\"")))) {
      if (/^https:\/\/github\.com\//.test(href)) continue;
      assert.ok(pages.has(href) || anchors.has(href), href);
    }
  });
});
