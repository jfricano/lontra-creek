/**
 * Turns TypeDoc's JSON model of the installed `streamotter` package into the pages of the
 * site's API reference (/docs/api/). It runs at build time, from integrations/api-reference.mjs,
 * and is pure so the tests can feed it a model. The output is plain data: every HTML fragment
 * in it is built here, from escaped text, so the pages only place them.
 */
import MarkdownIt from "markdown-it";
import { API_MODULES, apiModuleHref, apiSymbolHref, type ApiModuleInfo } from "./modules.ts";

/* TypeDoc's JSON output (typedoc's JSONOutput), reduced to the fields this file reads. */

/** A comment fragment: text, a code span, or an inline tag such as {@link}. */
export interface TdPart { kind: "text" | "code" | "inline-tag" | "relative-link"; text: string; tag?: string; target?: unknown }
export interface TdTag { tag: string; name?: string; content: TdPart[] }
export interface TdComment { summary: TdPart[]; blockTags?: TdTag[]; modifierTags?: string[] }
export interface TdType {
  type: string;
  name?: string;
  value?: unknown;
  target?: unknown;
  typeArguments?: TdType[];
  refersToTypeParameter?: boolean;
  types?: TdType[];
  elementType?: TdType;
  elements?: TdType[];
  element?: TdType;
  isOptional?: boolean;
  operator?: string;
  objectType?: TdType;
  indexType?: TdType;
  declaration?: TdReflection;
  checkType?: TdType;
  extendsType?: TdType;
  trueType?: TdType;
  falseType?: TdType;
  asserts?: boolean;
  targetType?: TdType;
  queryType?: TdType;
  head?: string;
  tail?: [TdType, string][];
  parameter?: string;
  parameterType?: TdType;
  templateType?: TdType;
  nameType?: TdType;
  readonlyModifier?: "+" | "-";
  optionalModifier?: "+" | "-";
  constraint?: TdType;
}
export interface TdReflection {
  id: number;
  name: string;
  kind: number;
  flags?: Partial<Record<"isOptional" | "isRest" | "isReadonly" | "isStatic" | "isAbstract" | "isConst", boolean>>;
  comment?: TdComment;
  children?: TdReflection[];
  signatures?: TdReflection[];
  indexSignatures?: TdReflection[];
  getSignature?: TdReflection;
  setSignature?: TdReflection;
  parameters?: TdReflection[];
  typeParameters?: TdReflection[];
  type?: TdType;
  default?: TdType;
  defaultValue?: string;
  extendedTypes?: TdType[];
  implementedTypes?: TdType[];
  inheritedFrom?: TdType;
  sources?: { fileName: string; line: number }[];
  /** On a reference (a re-export): the id of the declaration it re-exports. */
  target?: number;
}
export interface TdProject { children?: TdReflection[] }

/** TypeDoc's ReflectionKind values that this file distinguishes. */
export const KIND = {
  Module: 2, Namespace: 4, Enum: 8, EnumMember: 16, Variable: 32, Function: 64, Class: 128, Interface: 256,
  Constructor: 512, Property: 1024, Method: 2048, TypeLiteral: 65536, Accessor: 262144, TypeAlias: 2097152, Reference: 4194304
} as const;

/* The reference the pages render. */

export type ApiKind = "function" | "class" | "interface" | "type" | "variable" | "enum" | "namespace";

/** One row of an export list. `summaryHtml` is inline HTML (no block elements). */
export interface ApiExport { name: string; kind: ApiKind; href: string; summaryHtml: string; summaryText: string; reexport: boolean }

export interface ApiModule extends ApiModuleInfo { href: string; exports: ApiExport[] }

/** A labelled block under a declaration: Returns, Throws, Default, See, or an unrecognized tag. */
export interface ApiNote { label: string; html: string }
/** An example: a code sample for the site's highlighter, or markdown that was more than a sample. */
export type ApiExample = { code: string; lang: string } | { html: string };

export interface ApiParameter { name: string; typeHtml: string; optional: boolean; rest: boolean; html: string }
export interface ApiSignature {
  /** The whole signature as linked, escaped code. */
  codeHtml: string;
  docHtml: string;
  parameters: ApiParameter[];
  notes: ApiNote[];
  examples: ApiExample[];
}
export interface ApiMember {
  name: string;
  anchor: string;
  kind: "property" | "method" | "constructor" | "accessor" | "index" | "call";
  /** For properties, accessors, and index signatures: the member's declaration as linked code. */
  codeHtml: string;
  docHtml: string;
  notes: ApiNote[];
  signatures: ApiSignature[];
  inheritedFrom: string | null;
  deprecatedHtml: string | null;
}
export interface ApiSymbol {
  name: string;
  kind: ApiKind;
  module: string;
  /** The page's last path segment: the name, unless it differs only in case from another's (see pathSegments). */
  segment: string;
  href: string;
  /** Every import path that exports this symbol, the canonical one first. */
  importPaths: string[];
  typeOnly: boolean;
  summaryHtml: string;
  summaryText: string;
  /** The description after its first paragraph (which is `summaryHtml`). */
  bodyHtml: string;
  /** The declaration as linked code: a function's signatures sit in `signatures` instead. */
  codeHtml: string | null;
  signatures: ApiSignature[];
  members: ApiMember[];
  notes: ApiNote[];
  examples: ApiExample[];
  deprecatedHtml: string | null;
  sourceUrl: string | null;
}
export interface ApiReference { release: string; modules: ApiModule[]; symbols: ApiSymbol[] }

export interface BuildOptions {
  release: string;
  /** Maps a declaration's source file (as TypeDoc reports it) to a page on GitHub, or null. */
  sourceUrl?: (fileName: string, line: number) => string | null;
}

const KIND_OF: Readonly<Record<number, ApiKind>> = {
  [KIND.Function]: "function", [KIND.Class]: "class", [KIND.Interface]: "interface", [KIND.TypeAlias]: "type",
  [KIND.Variable]: "variable", [KIND.Enum]: "enum", [KIND.Namespace]: "namespace"
};
const TYPE_ONLY: ReadonlySet<ApiKind> = new Set(["interface", "type"]);

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

/** Comments are the package's own TSDoc, rendered as CommonMark with raw HTML switched off. */
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const memberName = (name: string) => IDENTIFIER.test(name) ? name : JSON.stringify(name);
/** A fragment id for a member: its name, with anything outside [A-Za-z0-9_-] replaced. */
const anchorFor = (name: string) => `member-${name.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "anonymous"}`;

/** Builds the reference. Throws when the model lacks an import path the site documents. */
export function buildApiReference(project: TdProject, options: BuildOptions): ApiReference {
  const byName = new Map((project.children ?? []).map(module => [module.name, module]));
  for (const info of API_MODULES) {
    if (!byName.has(info.entry)) throw new Error(`API reference: the TypeDoc model has no ${info.entry} entry point for ${info.importPath}.`);
  }

  // Where each declaration and member lives. A symbol re-exported by several entry points is
  // declared once, in the first (contracts); the others hold references to it.
  const symbolHref = new Map<number, string>();
  const homes: { info: ApiModuleInfo; declaration: TdReflection; segment: string }[] = [];
  const importPaths = new Map<number, string[]>();
  const anchorsOf = new Map<number, Map<number, string>>();
  for (const info of API_MODULES) {
    const declared = (byName.get(info.entry)!.children ?? []).filter(child => child.kind !== KIND.Reference && child.kind in KIND_OF);
    const segments = pathSegments(declared);
    for (const child of declared) {
      const segment = segments.get(child.id)!;
      const href = apiSymbolHref(info.slug, segment);
      symbolHref.set(child.id, href);
      homes.push({ info, declaration: child, segment });
      const anchors = new Map<number, string>();
      const used = new Set<string>();
      for (const member of membersOf(child)) {
        let anchor = anchorFor(member.name);
        for (let n = 2; used.has(anchor); n++) anchor = `${anchorFor(member.name)}-${n}`;
        used.add(anchor);
        anchors.set(member.id, anchor);
        symbolHref.set(member.id, `${href}#${anchor}`);
      }
      anchorsOf.set(child.id, anchors);
    }
  }
  for (const info of API_MODULES) {
    for (const child of byName.get(info.entry)!.children ?? []) {
      const id = child.kind === KIND.Reference ? child.target : child.id;
      if (id === undefined || !symbolHref.has(id)) continue;
      const paths = importPaths.get(id) ?? [];
      if (!paths.includes(info.importPath)) paths.push(info.importPath);
      importPaths.set(id, paths);
    }
  }

  const ctx: Context = { symbolHref, sourceUrl: options.sourceUrl ?? (() => null) };
  const symbols = homes.map(({ info, declaration, segment }) =>
    renderSymbol(ctx, info, declaration, segment, importPaths.get(declaration.id) ?? [info.importPath], anchorsOf.get(declaration.id)!));
  const bySymbolId = new Map(homes.map(({ declaration }, index) => [declaration.id, symbols[index]!]));

  const modules = API_MODULES.map(info => {
    const exports: ApiExport[] = [];
    for (const child of byName.get(info.entry)!.children ?? []) {
      const id = child.kind === KIND.Reference ? child.target : child.id;
      const symbol = id === undefined ? undefined : bySymbolId.get(id);
      if (symbol === undefined) continue;
      exports.push({
        name: child.name, kind: symbol.kind, href: symbol.href, summaryHtml: symbol.summaryHtml, summaryText: symbol.summaryText,
        reexport: symbol.module !== info.slug
      });
    }
    exports.sort((a, b) => a.name.localeCompare(b.name, "en"));
    return { ...info, href: apiModuleHref(info.slug), exports };
  });
  return { release: options.release, modules, symbols };
}

/** Type declarations first: in a clash, the interface or type keeps the bare name. */
const SEGMENT_PRIORITY: readonly ApiKind[] = ["class", "interface", "type", "enum", "namespace", "function", "variable"];

/**
 * Each declaration's URL segment. Names that differ only in case (the StreamError interface and
 * the streamError function) would share a directory on a case-insensitive disk, so all but the
 * first of them, by SEGMENT_PRIORITY, take their kind as a suffix: `streamError-function`.
 */
function pathSegments(declarations: readonly TdReflection[]): Map<number, string> {
  const groups = new Map<string, TdReflection[]>();
  for (const declaration of declarations) {
    const key = declaration.name.toLowerCase();
    groups.set(key, [...groups.get(key) ?? [], declaration]);
  }
  const segments = new Map<number, string>();
  for (const group of groups.values()) {
    const rank = (declaration: TdReflection) => SEGMENT_PRIORITY.indexOf(KIND_OF[declaration.kind]!);
    [...group].sort((a, b) => rank(a) - rank(b)).forEach((declaration, index) => {
      segments.set(declaration.id, index === 0 ? declaration.name : `${declaration.name}-${KIND_OF[declaration.kind]}`);
    });
  }
  return segments;
}

interface Context {
  symbolHref: ReadonlyMap<number, string>;
  sourceUrl: (fileName: string, line: number) => string | null;
}

/** The members a declaration's page lists: an interface's or class's, or an object type alias's. */
function membersOf(declaration: TdReflection): TdReflection[] {
  const holder = declaration.kind === KIND.TypeAlias && declaration.type?.type === "reflection" ? declaration.type.declaration : declaration;
  if (holder === undefined || declaration.kind === KIND.Function || declaration.kind === KIND.Variable) return [];
  return [...holder.children ?? []];
}

function renderSymbol(ctx: Context, info: ApiModuleInfo, declaration: TdReflection, segment: string, paths: string[], anchors: Map<number, string>): ApiSymbol {
  const kind = KIND_OF[declaration.kind]!;
  // A function's comment sits on its signatures; the first carries the summary for lists.
  const comment = declaration.comment ?? (kind === "function" ? declaration.signatures?.[0]?.comment : undefined);
  const doc = commentHtml(ctx, comment);
  const source = declaration.sources?.[0];
  const ordered = [info.importPath, ...paths.filter(path => path !== info.importPath)];

  let codeHtml: string | null = null;
  let signatures: ApiSignature[] = [];
  let members: ApiMember[] = [];
  if (kind === "function") {
    signatures = (declaration.signatures ?? []).map(signature => renderSignature(ctx, signature, `function ${declaration.name}`, signature === declaration.signatures?.[0] && declaration.comment === undefined));
  } else if (kind === "variable") {
    codeHtml = `<span class="kw">${declaration.flags?.isConst === false ? "let" : "const"}</span> ${escapeHtml(declaration.name)}: ${typeHtml(ctx, declaration.type)}`;
  } else if (kind === "type") {
    const target = declaration.type;
    const objectLike = target?.type === "reflection" && (target.declaration?.children?.length ?? 0) > 0 && !(target.declaration?.signatures?.length);
    codeHtml = `<span class="kw">type</span> ${escapeHtml(declaration.name)}${typeParametersHtml(ctx, declaration.typeParameters)} = ${objectLike ? "{ … }" : typeHtml(ctx, target, { block: true })}`;
    if (target?.type === "reflection" && target.declaration?.signatures?.length) {
      signatures = target.declaration.signatures.map(signature => renderSignature(ctx, signature, null, false));
    }
  } else if (kind === "interface" || kind === "class") {
    const heritage = [
      declaration.extendedTypes?.length ? ` <span class="kw">extends</span> ${declaration.extendedTypes.map(type => typeHtml(ctx, type)).join(", ")}` : "",
      declaration.implementedTypes?.length ? ` <span class="kw">implements</span> ${declaration.implementedTypes.map(type => typeHtml(ctx, type)).join(", ")}` : ""
    ].join("");
    codeHtml = `<span class="kw">${kind}</span> ${escapeHtml(declaration.name)}${typeParametersHtml(ctx, declaration.typeParameters)}${heritage}`;
  } else {
    codeHtml = `<span class="kw">${kind}</span> ${escapeHtml(declaration.name)}`;
  }

  const holder = declaration.kind === KIND.TypeAlias && declaration.type?.type === "reflection" ? declaration.type.declaration : declaration;
  if (kind !== "function" && kind !== "variable" && holder !== undefined) {
    members = [
      ...(holder.indexSignatures ?? []).map(signature => renderIndexSignature(ctx, signature)),
      ...membersOf(declaration)
        // Members inherited from outside the package (Error's message and stack) are the platform's.
        .filter(member => member.inheritedFrom === undefined || referencesDocumented(ctx, member.inheritedFrom))
        .map(member => renderMember(ctx, member, anchors.get(member.id)!, declaration.name))
    ];
    if (kind === "interface" && holder.signatures?.length) {
      members.unshift(...holder.signatures.map((signature, index) => ({
        name: "(call)", anchor: `call-${index + 1}`, kind: "call" as const, codeHtml: "", docHtml: "", notes: [], inheritedFrom: null, deprecatedHtml: null,
        signatures: [renderSignature(ctx, signature, null, false)]
      })));
    }
  }

  return {
    name: declaration.name,
    kind,
    module: info.slug,
    segment,
    href: ctx.symbolHref.get(declaration.id)!,
    importPaths: ordered,
    typeOnly: TYPE_ONLY.has(kind),
    summaryHtml: doc.summaryInline,
    summaryText: doc.summaryText,
    bodyHtml: doc.bodyHtml,
    codeHtml,
    signatures,
    members,
    notes: doc.notes,
    examples: doc.examples,
    deprecatedHtml: doc.deprecated,
    sourceUrl: source === undefined ? null : ctx.sourceUrl(source.fileName, source.line)
  };
}

function referencesDocumented(ctx: Context, type: TdType): boolean {
  return typeof type.target === "number" && ctx.symbolHref.has(type.target);
}

function renderMember(ctx: Context, member: TdReflection, anchor: string, owner: string): ApiMember {
  const inheritedFrom = member.inheritedFrom === undefined ? null : typeHtml(ctx, member.inheritedFrom);
  const name = escapeHtml(memberName(member.name));
  if (member.kind === KIND.Method || member.kind === KIND.Constructor) {
    const constructor = member.kind === KIND.Constructor;
    const doc = commentHtml(ctx, member.comment);
    return {
      name: constructor ? "constructor" : member.name, anchor, kind: constructor ? "constructor" : "method", codeHtml: "", docHtml: doc.html, notes: doc.notes,
      signatures: (member.signatures ?? []).map(signature => renderSignature(ctx, signature, constructor ? `new ${owner}` : memberName(member.name), false, constructor)),
      inheritedFrom, deprecatedHtml: doc.deprecated
    };
  }
  if (member.kind === KIND.Accessor) {
    const signature = member.getSignature ?? member.setSignature;
    const doc = commentHtml(ctx, signature?.comment ?? member.comment);
    const readonly = member.setSignature === undefined ? "readonly " : "";
    const type = member.getSignature?.type ?? member.setSignature?.parameters?.[0]?.type;
    return { name: member.name, anchor, kind: "accessor", codeHtml: `${readonly}${name}: ${typeHtml(ctx, type)}`, docHtml: doc.html, notes: doc.notes, signatures: [], inheritedFrom, deprecatedHtml: doc.deprecated };
  }
  // A property. One whose type is a function with a documented signature lists it, so its
  // parameters show; the property's own comment stays the member's description.
  const doc = commentHtml(ctx, member.comment);
  const readonly = member.flags?.isReadonly ? "readonly " : "";
  const optional = member.flags?.isOptional ? "?" : "";
  const fn = member.type?.type === "reflection" ? member.type.declaration?.signatures : undefined;
  const documented = fn?.some(signature => signature.comment !== undefined || signature.parameters?.some(parameter => parameter.comment !== undefined)) ?? false;
  return {
    name: member.name, anchor, kind: "property",
    codeHtml: `${readonly}${name}${optional}: ${typeHtml(ctx, member.type)}`,
    docHtml: doc.html, notes: doc.notes,
    signatures: documented ? fn!.map(signature => renderSignature(ctx, signature, null, false)) : [],
    inheritedFrom, deprecatedHtml: doc.deprecated
  };
}

function renderIndexSignature(ctx: Context, signature: TdReflection): ApiMember {
  const doc = commentHtml(ctx, signature.comment);
  const parameter = signature.parameters?.[0];
  const readonly = signature.flags?.isReadonly ? "readonly " : "";
  return {
    name: "[index]", anchor: "index-signature", kind: "index",
    codeHtml: `${readonly}[${escapeHtml(parameter?.name ?? "key")}: ${typeHtml(ctx, parameter?.type)}]: ${typeHtml(ctx, signature.type)}`,
    docHtml: doc.html, notes: doc.notes, signatures: [], inheritedFrom: null, deprecatedHtml: doc.deprecated
  };
}

/**
 * One call signature. `lead` is what precedes the parameters ("function name", a method's name,
 * "new", or null for a bare function type). `summaryIsSymbols` marks the signature whose comment
 * is already the symbol's description, so it isn't repeated.
 */
function renderSignature(ctx: Context, signature: TdReflection, lead: string | null, summaryIsSymbols: boolean, constructor = false): ApiSignature {
  const doc = commentHtml(ctx, signature.comment);
  const parameters = (signature.parameters ?? []).map(parameter => {
    const parameterDoc = commentHtml(ctx, parameter.comment);
    return {
      name: parameter.name, typeHtml: typeHtml(ctx, parameter.type), optional: parameter.flags?.isOptional === true || parameter.defaultValue !== undefined,
      rest: parameter.flags?.isRest === true, html: parameterDoc.html
    };
  });
  const parameterList = parameters.map(parameter => `${parameter.rest ? "..." : ""}${escapeHtml(parameter.name)}${parameter.optional ? "?" : ""}: ${parameter.typeHtml}`);
  const joined = parameterList.join(", ");
  const list = textLength(joined) > 72 ? `\n  ${parameterList.join(",\n  ")}\n` : joined;
  const typeParameters = typeParametersHtml(ctx, signature.typeParameters);
  const returns = constructor ? "" : lead === null ? ` => ${typeHtml(ctx, signature.type)}` : `: ${typeHtml(ctx, signature.type)}`;
  const head = lead === null ? "" : escapeHtml(lead).replace(/^(function|new)\b/, "<span class=\"kw\">$1</span>");
  return {
    codeHtml: `${head}${typeParameters}(${list})${returns}`,
    docHtml: summaryIsSymbols ? "" : doc.html,
    parameters: parameters.some(parameter => parameter.html !== "") ? parameters : [],
    notes: summaryIsSymbols ? [] : doc.notes,
    examples: summaryIsSymbols ? [] : doc.examples
  };
}

function typeParametersHtml(ctx: Context, parameters: TdReflection[] | undefined): string {
  if (!parameters?.length) return "";
  return `&lt;${parameters.map(parameter => [
    escapeHtml(parameter.name),
    parameter.type === undefined ? "" : ` <span class="kw">extends</span> ${typeHtml(ctx, parameter.type)}`,
    parameter.default === undefined ? "" : ` = ${typeHtml(ctx, parameter.default)}`
  ].join("")).join(", ")}&gt;`;
}

/* Types */

interface TypeOptions { block?: boolean }

/** Wraps a type that would bind wrongly as an array element or inside an intersection. */
function grouped(ctx: Context, type: TdType | undefined): string {
  const html = typeHtml(ctx, type);
  const loose = type?.type === "union" || type?.type === "intersection" || type?.type === "conditional" ||
    (type?.type === "reflection" && (type.declaration?.signatures?.length ?? 0) > 0);
  return loose ? `(${html})` : html;
}

/** A type as escaped code, its references linked to their pages. `block` lays a long union out one member per line. */
export function typeHtml(ctx: Context, type: TdType | undefined, options: TypeOptions = {}): string {
  if (type === undefined) return "<span class=\"kw\">unknown</span>";
  switch (type.type) {
    case "intrinsic":
      return `<span class="kw">${escapeHtml(type.name ?? "unknown")}</span>`;
    case "literal": {
      const value = type.value;
      if (value === null) return "<span class=\"kw\">null</span>";
      if (typeof value === "object") {
        const big = value as { negative?: boolean; value?: string };
        return `<span class="lit">${big.negative ? "-" : ""}${escapeHtml(String(big.value))}n</span>`;
      }
      return `<span class="lit">${escapeHtml(typeof value === "string" ? JSON.stringify(value) : String(value))}</span>`;
    }
    case "reference": {
      const name = escapeHtml(type.name ?? "");
      const href = typeof type.target === "number" && !type.refersToTypeParameter ? ctx.symbolHref.get(type.target) : undefined;
      const head = href === undefined ? name : `<a href="${escapeHtml(href)}">${name}</a>`;
      const args = type.typeArguments?.length ? `&lt;${type.typeArguments.map(argument => typeHtml(ctx, argument)).join(", ")}&gt;` : "";
      return head + args;
    }
    case "union": {
      const parts = (type.types ?? []).map(member => typeHtml(ctx, member));
      const flat = parts.join(" | ");
      if (options.block && parts.length > 1 && textLength(flat) > 60) {
        // One member per line; an object member that is still long lists one field per line.
        const lines = (type.types ?? []).map((member, index) =>
          member.type === "reflection" && textLength(parts[index]!) > 72 ? reflectionTypeHtml(ctx, member.declaration, "    ") : parts[index]!);
        return `\n  | ${lines.join("\n  | ")}`;
      }
      return flat;
    }
    case "intersection":
      return (type.types ?? []).map(member => grouped(ctx, member)).join(" &amp; ");
    case "array":
      return `${grouped(ctx, type.elementType)}[]`;
    case "tuple":
      return `[${(type.elements ?? []).map(element => typeHtml(ctx, element)).join(", ")}]`;
    case "namedTupleMember":
      return `${escapeHtml(type.name ?? "")}${type.isOptional ? "?" : ""}: ${typeHtml(ctx, type.element)}`;
    case "optional":
      return `${grouped(ctx, type.elementType)}?`;
    case "rest":
      return `...${typeHtml(ctx, type.elementType)}`;
    case "typeOperator":
      return `<span class="kw">${escapeHtml(type.operator ?? "")}</span> ${grouped(ctx, type.target as TdType | undefined)}`;
    case "indexedAccess":
      return `${grouped(ctx, type.objectType)}[${typeHtml(ctx, type.indexType)}]`;
    case "conditional":
      return `${grouped(ctx, type.checkType)} <span class="kw">extends</span> ${typeHtml(ctx, type.extendsType)} ? ${typeHtml(ctx, type.trueType)} : ${typeHtml(ctx, type.falseType)}`;
    case "inferred":
      return `<span class="kw">infer</span> ${escapeHtml(type.name ?? "")}${type.constraint ? ` <span class="kw">extends</span> ${typeHtml(ctx, type.constraint)}` : ""}`;
    case "predicate":
      return `${type.asserts ? "<span class=\"kw\">asserts</span> " : ""}${escapeHtml(type.name ?? "")}${type.targetType ? ` <span class="kw">is</span> ${typeHtml(ctx, type.targetType)}` : ""}`;
    case "query":
      return `<span class="kw">typeof</span> ${typeHtml(ctx, type.queryType)}`;
    case "templateLiteral":
      return `<span class="lit">\`${escapeHtml(type.head ?? "")}${(type.tail ?? []).map(([inner, text]) => `\${${typeHtml(ctx, inner)}}${escapeHtml(text)}`).join("")}\`</span>`;
    case "mapped": {
      const readonly = type.readonlyModifier === "+" ? "readonly " : type.readonlyModifier === "-" ? "-readonly " : "";
      const optional = type.optionalModifier === "+" ? "?" : type.optionalModifier === "-" ? "-?" : "";
      const as = type.nameType ? ` <span class="kw">as</span> ${typeHtml(ctx, type.nameType)}` : "";
      return `{ ${readonly}[${escapeHtml(type.parameter ?? "K")} <span class="kw">in</span> ${typeHtml(ctx, type.parameterType)}${as}]${optional}: ${typeHtml(ctx, type.templateType)} }`;
    }
    case "reflection":
      return reflectionTypeHtml(ctx, type.declaration);
    default:
      return escapeHtml(type.name ?? type.type);
  }
}

/** The length of a fragment's visible text, to decide when to break it across lines. */
const textLength = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&#?\w+;/g, "x").length;

/** An inline object or function type. With `indent`, an object's fields go one per line at that indent. */
function reflectionTypeHtml(ctx: Context, declaration: TdReflection | undefined, indent: string | null = null): string {
  if (declaration === undefined) return "{}";
  const signatures = declaration.signatures ?? [];
  const children = declaration.children ?? [];
  const index = declaration.indexSignatures ?? [];
  if (signatures.length > 0 && children.length === 0 && index.length === 0) {
    const rendered = signatures.map(signature => {
      const parameters = (signature.parameters ?? []).map(parameter =>
        `${parameter.flags?.isRest ? "..." : ""}${escapeHtml(parameter.name)}${parameter.flags?.isOptional ? "?" : ""}: ${typeHtml(ctx, parameter.type)}`);
      return `${typeParametersHtml(ctx, signature.typeParameters)}(${parameters.join(", ")}) =&gt; ${typeHtml(ctx, signature.type)}`;
    });
    return rendered.length === 1 ? rendered[0]! : `{ ${rendered.map(signature => `${signature.replace(" =&gt; ", ": ")}`).join("; ")} }`;
  }
  const fields = [
    ...index.map(signature => {
      const parameter = signature.parameters?.[0];
      return `[${escapeHtml(parameter?.name ?? "key")}: ${typeHtml(ctx, parameter?.type)}]: ${typeHtml(ctx, signature.type)}`;
    }),
    ...children.map(child => {
      if (child.kind === KIND.Method) {
        return (child.signatures ?? []).map(signature => `${escapeHtml(memberName(child.name))}${reflectionTypeHtml(ctx, { ...child, kind: KIND.TypeLiteral, signatures: [signature], children: [] }).replace(/ =&gt; /, ": ")}`).join("; ");
      }
      return `${child.flags?.isReadonly ? "readonly " : ""}${escapeHtml(memberName(child.name))}${child.flags?.isOptional ? "?" : ""}: ${typeHtml(ctx, child.type)}`;
    })
  ];
  if (fields.length === 0) return "{}";
  return indent === null ? `{ ${fields.join("; ")} }` : `{\n${fields.map(field => `${indent}${field};`).join("\n")}\n${indent.slice(2)}}`;
}

/* Comments */

interface RenderedComment {
  /** Summary and remarks, as block HTML. */
  html: string;
  /** Everything in `html` after the summary's first paragraph, for pages that set that paragraph apart. */
  bodyHtml: string;
  /** The summary's first paragraph, as inline HTML, for export lists. */
  summaryInline: string;
  /** The summary's first paragraph as plain text, for meta descriptions and the filter. */
  summaryText: string;
  notes: ApiNote[];
  examples: ApiExample[];
  deprecated: string | null;
}

const NOTE_LABELS: Readonly<Record<string, string>> = {
  "@returns": "Returns", "@throws": "Throws", "@defaultValue": "Default", "@default": "Default", "@see": "See also", "@since": "Since"
};

function partsToMarkdown(ctx: Context, parts: readonly TdPart[] | undefined): string {
  return (parts ?? []).map(part => {
    if (part.kind !== "inline-tag") return part.text;
    const href = typeof part.target === "number" ? ctx.symbolHref.get(part.target) : undefined;
    const text = part.text.trim();
    if (href === undefined) return `\`${text.replace(/`/g, "")}\``;
    const label = part.tag === "@linkplain" ? text.replace(/[[\]]/g, "") : `\`${text.replace(/`/g, "")}\``;
    return `[${label}](${href})`;
  }).join("");
}

function commentHtml(ctx: Context, comment: TdComment | undefined): RenderedComment {
  const summaryMarkdown = partsToMarkdown(ctx, comment?.summary).trim();
  const firstParagraph = summaryMarkdown.split(/\n\s*\n/)[0] ?? "";
  const tags = comment?.blockTags ?? [];
  const remarks = tags.filter(tag => tag.tag === "@remarks").map(tag => partsToMarkdown(ctx, tag.content).trim()).join("\n\n");
  const notes: ApiNote[] = [];
  const examples: ApiExample[] = [];
  let deprecated: string | null = null;
  for (const tag of tags) {
    const content = partsToMarkdown(ctx, tag.content).trim();
    if (tag.tag === "@remarks" || tag.tag === "@param" || tag.tag === "@typeParam") continue;
    if (tag.tag === "@example") {
      const fence = /^```(\w*)\n([\s\S]*?)\n```$/.exec(content);
      examples.push(fence ? { lang: fence[1] || "ts", code: fence[2]! } : { html: markdown.render(content) });
    } else if (tag.tag === "@deprecated") {
      deprecated = content === "" ? "" : markdown.render(content);
    } else {
      const label = NOTE_LABELS[tag.tag] ?? tag.tag.slice(1);
      // A default is usually a bare value; TypeDoc keeps it as code.
      notes.push({ label, html: markdown.render(content) });
    }
  }
  const remarksHtml = remarks === "" ? "" : markdown.render(remarks);
  const laterParagraphs = summaryMarkdown.slice(firstParagraph.length).trim();
  return {
    html: (summaryMarkdown === "" ? "" : markdown.render(summaryMarkdown)) + remarksHtml,
    bodyHtml: (laterParagraphs === "" ? "" : markdown.render(laterParagraphs)) + remarksHtml,
    summaryInline: firstParagraph === "" ? "" : markdown.renderInline(firstParagraph.replace(/\s*\n\s*/g, " ")),
    summaryText: plainText(firstParagraph),
    notes,
    examples,
    deprecated
  };
}

/** Markdown to plain text, enough for a meta description: links keep their text, code keeps its content. */
function plainText(markdownText: string): string {
  return markdownText.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`([^`]*)`/g, "$1").replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1").replace(/\s+/g, " ").trim();
}
