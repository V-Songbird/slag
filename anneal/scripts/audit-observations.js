"use strict";

// The audit's observations, apart from its findings. audit.js requires it
// and passes in the findings' evidence together with its own limits and path
// helpers, so an observation words and classifies a path as the findings do.

const path = require("node:path");

// Observations: routes to package entry points and document sections, and what
// explains a finding's evidence. They carry no severity and change no finding.
const DOCUMENT_EXTENSIONS = new Set(["md", "mdx", "markdown", "rst", "adoc"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);
// The size at which session evidence calls a document long.
const LONG_DOCUMENT_CHARS = 20000;
// Claude Code and Gemini CLI load a file their map names as @path, five hops
// deep. Codex does not, so an @path in AGENTS.md is only a mention.
const IMPORTING_MAPS = new Set(["CLAUDE.md", "GEMINI.md"]);
const MAX_IMPORT_HOPS = 5;
const PACKAGE_MANIFEST = /^(?:package\.json|pyproject\.toml|setup\.py|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|Gemfile|pubspec\.yaml|mix\.exs|.+\.(?:csproj|fsproj|vbproj|gemspec))$/;
const ROUTE_DIRS = new Set(["app", "pages", "routes"]);
const JVM_SOURCES = /^((?:.*\/)?src\/(?:main|test|androidTest|testFixtures)\/(?:java|kotlin|scala|groovy)\/)/;
const DIST_BUILDERS = /\b(?:build|dist|tsc|vite|rollup|webpack|esbuild|babel|tsup|parcel|swc|ncc|microbundle|unbuild|rspack|rolldown|turbo|nx|lerna|gulp|grunt|make)\b/;
const BUNDLER_CONFIG = /^(?:vite|rollup|webpack|tsup|rspack|rolldown|esbuild)\.config\.[cm]?[jt]s$/;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const LINK = /\]\(\s*<?([^\s()<>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)|^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/g;
const IMPORT = /(?:^|\s)@([^\s`'"()<>[\]]+)/g;
const URL = /\b[a-z][\w+.-]*:\/\/\S+/gi;
const PATH_TOKEN = /(?:\.{1,2}\/)*\.?[\w+-][\w@.+-]*(?:\/\.?[\w@+-][\w@.+-]*)*\/?/g;
const TREE_ENTRY = /^([\s│├└─┬┼|`'+\\-]*)([^\s│├└─┬┼|#]+)/;
const EXPLICIT_ANCHOR = /\b(?:id|name)=["']([^"']+)["']|\{#([\w-]+)\}/g;

// A heading's anchor as GitHub writes it.
const slugOf = (title) => title.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "").trim().toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-");
const isParagraph = (line) => Boolean(line?.trim()) && !/^ {0,3}(?:[-*+>|#]|\d+[.)]\s)/.test(line) && !SETEXT_UNDERLINE.test(line) && !FENCE.test(line);
const decode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

// One Markdown file: each repository path it names, with the line and the form
// that names it (prose, table, link, import, or a tree or code in a code
// block), its @path imports, section links, headings and anchors.
function parseMarkdown(file, text, kind, dirsOf) {
  const dir = dirsOf(file).join("/");
  const found = (...candidates) => candidates.map((candidate) => path.posix.normalize(candidate).replace(/\/+$/, ""))
    .find((candidate) => !/^(?:\.\.?(?:\/|$)|\/)/.test(candidate) && kind(candidate)) ?? null;
  // Outside code, a bare word counts only with a slash or an extension.
  const tokenPath = (token, code) => {
    const trimmed = token.replace(/[.,:;!?]+$/, "");
    return code || /\/|\.[\w-]+$/.test(trimmed) ? found(trimmed, path.posix.join(dir, trimmed)) : null;
  };
  const parsed = { text, named: [], imports: [], links: [], headings: [], anchors: new Set() };
  const seen = new Set();
  const name = (named, line, format) => {
    if (!named || seen.has(named)) return;
    seen.add(named);
    parsed.named.push({ path: named, line, format });
  };
  const slugs = new Map();
  const heading = (title, line) => {
    const base = slugOf(title);
    const n = slugs.get(base) || 0;
    slugs.set(base, n + 1);
    parsed.anchors.add(n ? `${base}-${n}` : base);
    parsed.headings.push(line);
  };

  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const start = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
  let fence = null;
  let tree = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const number = i + 1;
    const marker = FENCE.exec(line);
    if (fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) {
      fence = null;
      continue;
    }
    if (fence) {
      // A tree spells a path over several lines, one indented name per level.
      const entry = TREE_ENTRY.exec(line);
      if (entry) {
        const entryName = entry[2].replace(/^\.\//, "").replace(/\/+$/, "");
        while (tree.length && tree[tree.length - 1].width >= entry[1].length) tree.pop();
        const parents = tree.map((node) => node.name);
        tree.push({ width: entry[1].length, name: entryName });
        if (parents.length) name(found([...parents, entryName].join("/"), [...parents.slice(1), entryName].join("/")), number, "tree");
      }
      for (const token of line.replace(URL, " ").match(PATH_TOKEN) || []) name(tokenPath(token, true), number, "code");
      continue;
    }
    if (marker) {
      fence = marker[1];
      tree = [];
      continue;
    }

    const parts = line.split("`");
    const prose = parts.filter((_, k) => k % 2 === 0).join(" ");
    for (const match of prose.matchAll(LINK)) {
      const target = match[1] ?? match[2];
      if (!target || /^[a-z][\w+.-]*:|^\/\//i.test(target)) continue;
      const linked = decode(target.replace(/[?#].*/, ""));
      const resolved = linked ? found(linked.startsWith("/") ? linked.slice(1) : path.posix.join(dir, linked)) : file;
      if (resolved && linked) name(resolved, number, "link");
      if (resolved && target.includes("#")) parsed.links.push({ target: resolved, anchor: target.slice(target.indexOf("#") + 1), line: number });
    }
    for (const match of prose.replace(LINK, " ").matchAll(IMPORT)) {
      const target = match[1].replace(/[.,:;!?]+$/, "");
      const imported = /^[~/]/.test(target) ? null : found(path.posix.join(dir, target));
      if (imported && kind(imported) === "file") {
        parsed.imports.push(imported);
        name(imported, number, "import");
      }
    }
    const format = /^\s*\|/.test(line) ? "table" : "prose";
    const segments = [[prose.replace(LINK, " ").replace(IMPORT, " "), false], ...parts.filter((_, k) => k % 2 === 1).map((span) => [span, true])];
    for (const [segment, code] of segments) {
      for (const token of segment.replace(URL, " ").match(PATH_TOKEN) || []) name(tokenPath(token, code), number, format);
    }

    const atx = ATX_HEADING.exec(line);
    if (atx) heading(atx[1] || "", number);
    else if (SETEXT_UNDERLINE.test(line) && i > start && isParagraph(lines[i - 1])) heading(lines[i - 1], number - 1);
    for (const match of line.matchAll(EXPLICIT_ANCHOR)) parsed.anchors.add((match[1] ?? match[2]).toLowerCase());
  }
  return parsed;
}

const firstString = (value) => (typeof value === "string" ? value : value && typeof value === "object" ? Object.values(value).map(firstString).find(Boolean) : undefined);
const tally = (counts, key) => counts.set(key, (counts.get(key) || 0) + 1);

// What the audit can say without a severity. `facts` holds the findings'
// evidence, so an observation only explains evidence the audit already found;
// `shared` holds the audit's own limits and path helpers.
function observe(files, reader, facts, shared) {
  const { EVIDENCE_LIMIT, OUTPUT_DIRS, ROUTE_NAMES, countLines, dirsOf, extensionOf, inBuildDir, inputDir, isGeneratedPath, nameGroup, plural, sized, stemOf } = shared;
  const observations = [];
  const observed = (id, title, evidence, note) => {
    if (evidence.length) observations.push({ id, title, count: evidence.length, evidence: evidence.slice(0, EVIDENCE_LIMIT), note });
  };
  const byRank = (rows) => rows.sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  const fileSet = new Set(files);
  const dirSet = new Set(files.flatMap((file) => dirsOf(file).map((_, i, dirs) => dirs.slice(0, i + 1).join("/"))));
  const kind = (candidate) => (fileSet.has(candidate) ? "file" : dirSet.has(candidate) ? "dir" : null);
  const cache = new Map();
  const parse = (file) => cache.get(file) ?? cache.set(file, parseMarkdown(file, reader.text(file), kind, dirsOf)).get(file);
  const isMarkdown = (file) => MARKDOWN_EXTENSIONS.has(extensionOf(file));

  // A map file, then every file its host loads through @path imports.
  const loads = (map) => {
    const loaded = [map];
    for (let hop = 0, next = [map]; IMPORTING_MAPS.has(path.posix.basename(map)) && hop < MAX_IMPORT_HOPS && next.length; hop++) {
      next = [...new Set(next.flatMap((file) => parse(file).imports))].filter((file) => !loaded.includes(file));
      loaded.push(...next);
    }
    return loaded;
  };
  const commands = facts.checks.commands.map((entry) => entry.command);
  observed("map-routes", "What each map file routes to, with the files it imports", facts.mapFiles.map((map) => {
    const loaded = loads(map);
    const named = [...new Set(loaded.flatMap((file) => parse(file).named.map((entry) => entry.path)))].filter((entry) => !loaded.includes(entry));
    const check = commands.find((command) => loaded.some((file) => parse(file).text.includes(command)));
    const head = `${map}: ${plural(countLines(parse(map).text), "line")}${loaded.length > 1 ? `, imports ${loaded.slice(1).join(", ")}` : ""}`;
    // Only the check commands the audit found can be matched; a map may name another one.
    const checks = check ? `, check command ${check}` : commands.length ? ` and none of the check commands found: ${commands.join(", ")}` : "";
    if (!named.length && !check) return `${head}; names no path or document${checks}`;
    const documents = named.filter((entry) => DOCUMENT_EXTENSIONS.has(extensionOf(entry))).length;
    return `${head}; names ${plural(named.length, "path")} (${plural(documents, "document")})${checks}`;
  }), "A path counts in prose, a table, a tree or a link. Length alone says nothing: a short map that names nothing routes nowhere.");

  // A package is a folder with its own manifest, outside build output and test inputs.
  const packages = new Map();
  for (const file of files.filter((entry) => PACKAGE_MANIFEST.test(path.posix.basename(entry)) && !inBuildDir(entry) && !inputDir(entry))) {
    const dir = dirsOf(file).join("/");
    packages.set(dir, [...(packages.get(dir) || []), path.posix.basename(file)]);
  }
  const entryOf = (dir) => {
    const pkg = packages.get(dir).includes("package.json") && reader.json(dir ? `${dir}/package.json` : "package.json");
    const declared = pkg && (firstString(pkg.exports) || pkg.module || pkg.main || firstString(pkg.bin));
    return typeof declared === "string" && declared ? path.posix.join(dir, declared).replace(/\/+$/, "") : null;
  };
  const entries = new Map([...packages.keys()].map((dir) => [entryOf(dir), dir ? `${dir}/package.json` : "package.json"]).filter(([entry]) => fileSet.has(entry)));
  const describeEntry = (dir) => {
    const entry = entryOf(dir);
    if (!packages.get(dir).includes("package.json")) return `manifest ${packages.get(dir).join(", ")}`;
    if (!entry) return "no entry declared";
    return kind(entry) ? `entry ${entry}` : `entry ${entry}, ${inBuildDir(entry) ? "build output" : "not found"}`;
  };
  const loaded = [...new Set(facts.mapFiles.flatMap(loads))];
  const inMap = loaded.flatMap((file) => parse(file).named.map((entry) => ({ ...entry, file })));
  const linked = [...new Set(inMap.map((entry) => entry.path))].filter((entry) => fileSet.has(entry) && isMarkdown(entry) && !loaded.includes(entry));
  const inLinked = linked.flatMap((doc) => parse(doc).named.map((entry) => ({ ...entry, file: doc })));
  const at = (entry) => `${entry.file}:${entry.line}`;
  observed("package-routes", "Packages, and the route the map gives to each", byRank([...packages.keys()].filter(Boolean).sort().map((dir) => {
    const within = (entry) => entry.path === dir || entry.path.startsWith(`${dir}/`);
    const [direct, second] = [inMap.find(within), inLinked.find(within)];
    const parent = inMap.filter((entry) => dir.startsWith(`${entry.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
    if (direct) return [3, `${dir}: named at ${at(direct)} (${direct.format}); ${describeEntry(dir)}`];
    if (second) return [2, `${dir}: named in ${at(second)}, a document the map names at ${at(inMap.find((entry) => entry.path === second.file))}; ${describeEntry(dir)}`];
    if (parent) return [1, `${dir}: not named; its folder ${parent.path}/ is, at ${at(parent)} (${parent.format}); ${describeEntry(dir)}`];
    return [0, `${dir}: not named in the map or a document it names; ${describeEntry(dir)}`];
  })), "A package the map already names needs no change, and the map need not name every package. A path hint or a Start here pointer is the smallest route to one that tasks keep missing.");

  const markdown = files.filter((file) => isMarkdown(file) && !inBuildDir(file) && !isGeneratedPath(file));
  const sectionLinks = new Map(markdown.filter((file) => !facts.mapFiles.includes(file) && parse(file).text.length >= LONG_DOCUMENT_CHARS).map((doc) => [doc, []]));
  for (const file of markdown) for (const link of parse(file).links) sectionLinks.get(link.target)?.push({ ...link, file });
  const documents = [...sectionLinks].map(([doc, links]) => {
    const { text, headings, anchors } = parse(doc);
    const lines = text.split("\n");
    const total = countLines(text);
    // The longest run of lines between two headings, or before the first one.
    const longest = [...headings, total + 1].map((end, k) => {
      const from = k ? headings[k - 1] + 1 : 1;
      return { from, to: end - 1, chars: lines.slice(from - 1, end - 1).reduce((sum, line) => sum + line.length + 1, 0) };
    }).reduce((a, b) => (b.chars > a.chars ? b : a));
    const broken = links.filter((link) => !anchors.has(decode(link.anchor).toLowerCase())).map((link) => `#${link.anchor} (${link.file}:${link.line})`);
    const detail = `${plural(total, "line")}, ${plural(headings.length, "heading")}`;
    const reach = `${links.length ? `; ${plural(links.length, "section link")} from ${plural(new Set(links.map((link) => link.file)).size, "file")}` : ""}${broken.length ? `; no heading for ${broken.slice(0, 3).join(", ")}` : ""}`;
    if (longest.chars < LONG_DOCUMENT_CHARS) return [2, `${doc}: navigable, ${detail}; its longest part without a heading is ${plural(longest.to - longest.from + 1, "line")}${reach}`];
    return [0, `${doc}: ${detail}; lines ${longest.from}-${longest.to} (${longest.chars} characters) have no heading${reach}`];
  });
  for (const file of files.filter((entry) => DOCUMENT_EXTENSIONS.has(extensionOf(entry)) && !isMarkdown(entry) && !inBuildDir(entry))) {
    const text = reader.text(file);
    if (text.length >= LONG_DOCUMENT_CHARS) documents.push([1, `${file}: ${plural(countLines(text), "line")}; headings in .${extensionOf(file)} files are not read, so its structure is unknown`]);
  }
  observed("document-sections", "Long documents, and how a reader reaches their parts", byRank(documents),
    "Length alone is no reason to split: headings and section links let a search or a range read reach one part. A long part without a heading is a candidate for a descriptive heading or a section link, which docs-align handles.");

  const owner = (file) => dirsOf(file).map((_, i, dirs) => dirs.slice(0, dirs.length - i).join("/")).concat("").find((dir) => packages.has(dir)) ?? null;
  observed("package-local-names", "Duplicate names that fall one per package", facts.duplicates.filter(([, group]) => {
    const owners = group.map(owner);
    return !owners.includes(null) && new Set(owners).size === group.length;
  }).map(nameGroup), "Each copy sits in its own package, so the package path tells them apart. A route to the package comes before any rename.");

  const required = (file) => {
    const route = dirsOf(file).findIndex((dir) => ROUTE_DIRS.has(dir));
    if (JVM_SOURCES.test(file)) return [JVM_SOURCES.exec(file)[1], "source folders that spell the package name"];
    if (route !== -1 && ROUTE_NAMES.has(stemOf(file))) return [`${dirsOf(file).slice(0, route + 1).join("/")}/`, "route files whose folders are URL segments"];
    return entries.has(file) ? [file, `the entry ${entries.get(file)} declares`] : null;
  };
  const requiredPaths = new Map();
  for (const [finding, list] of [["deep-nesting", facts.deepFiles], ["index-files", facts.indexFiles]]) {
    for (const [where, reason] of list.map(required).filter(Boolean)) {
      const key = `${finding}: ${where}`;
      requiredPaths.set(key, { reason, n: (requiredPaths.get(key)?.n || 0) + 1 });
    }
  }
  observed("framework-paths", "Findings on paths a framework, language or manifest requires",
    [...requiredPaths].map(([key, { reason, n }]) => (key.endsWith("/") ? `${key} (${plural(n, "file")}), ${reason}` : `${key}, ${reason}`)),
    "These paths stay where they are; the finding is no reason to rename or move them.");

  const builds = (dir) => {
    const inDir = (name) => (dir ? `${dir}/${name}` : name);
    return Object.entries(reader.json(inDir("package.json"))?.scripts || {}).some((script) => DIST_BUILDERS.test(script.join(" ")))
      || ["pyproject.toml", "setup.py", "setup.cfg", ".goreleaser.yml", ".goreleaser.yaml"].some((name) => fileSet.has(inDir(name)))
      || files.some((file) => path.posix.dirname(file) === (dir || ".") && BUNDLER_CONFIG.test(path.posix.basename(file)))
      || /"outDir"/.test(reader.text(inDir("tsconfig.json"))) || /\bdist\b/.test(reader.text(inDir("Makefile")));
  };
  const dists = new Map();
  const inputs = new Map();
  for (const file of facts.committed) {
    const dirs = dirsOf(file);
    const index = dirs.indexOf("dist");
    if (inputDir(file)) tally(inputs, inputDir(file));
    else if (index !== -1 && !dirs.slice(0, index).some((dir) => OUTPUT_DIRS.has(dir))) tally(dists, dirs.slice(0, index).join("/"));
  }
  observed("source-dist", "Tracked dist folders that nothing here builds", [...dists].filter(([folder]) => !builds(folder) && !builds(""))
    .map(([folder, n]) => `${folder ? `${folder}/` : ""}dist/ (${plural(n, "file")}): no build script, bundler config or compiler outDir in ${folder ? `${folder}/ or ` : ""}the root writes it`),
  "Such a folder may hold source or files kept on purpose. Confirm where it comes from before ignoring or untracking it.");
  observed("required-inputs", "Findings on fixtures and data kept on purpose", [
    ...[...inputs].map(([dir, n]) => `generated-looking: ${dir} (${plural(n, "file")})`),
    ...facts.large.filter((entry) => inputDir(entry.file)).map((entry) => `large-files: ${sized(entry)} under ${inputDir(entry.file)}`),
  ], "Fixtures, snapshots and data are content a test or the code reads; the finding is no reason to ignore, untrack or split them.");
  return observations;
}

module.exports = { observe };
