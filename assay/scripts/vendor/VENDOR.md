# Vendored parsers

assay parses instruction files with real parsers, and it installs nothing. Every
library below is committed here as its published single-file dist build and
loaded with a plain `require("./vendor/<name>.js")`. There is no `package.json`
anywhere in this plugin and no install step for a user.

**Never edit these files.** They are third-party sources reproduced verbatim,
license headers included. To move to a new version, re-download the tarball,
replace the file, and update the table below.

| Package | Version | License | Registry tarball | Integrity (`npm view <pkg>@<ver> dist.integrity`) |
| --- | --- | --- | --- | --- |
| `markdown-it` | 14.1.0 | MIT | https://registry.npmjs.org/markdown-it/-/markdown-it-14.1.0.tgz | `sha512-a54IwgWPaeBCAAsv13YgmALOF1elABB08FxO9i+r4VFk5Vl4pKokRPeX8u5TCgSsPi6ec1otfLjdOpVcgbpshg==` |
| `js-yaml` | 4.1.0 | MIT | https://registry.npmjs.org/js-yaml/-/js-yaml-4.1.0.tgz | `sha512-wpxZs9NoxZaJESJGIZTyDEaYpl0FKSA+FB9aJiyemKhMwkxQg63h4T1KJgUGHpTqPDNRcmmYLugrRjJlBtWvRA==` |
| `smol-toml` | 1.7.1 | BSD-3-Clause | https://registry.npmjs.org/smol-toml/-/smol-toml-1.7.1.tgz | `sha512-PPlsspAZ4jbMBu5DMFhfUGDQLu/vrL4SyBROVS37x8ynnVmFIs1VPBz1Co8Xks3TvpIaZXmU85y4DrQ+UyVFoQ==` |

Files taken from each tarball:

- `markdown-it.js` — `package/dist/markdown-it.js` (the plain UMD build, not the
  minified one).
- `js-yaml.js` — `package/dist/js-yaml.js` (the plain UMD build, not the
  minified one).
- `smol-toml.js` — `package/dist/index.cjs` (the CommonJS bundle; the ESM build
  beside it is unusable from a `require`-only plugin). Renamed on copy so the
  filename names the package, and otherwise byte-identical — including its
  trailing `sourceMappingURL` comment, which no map file accompanies and which
  affects nothing but a debugger.

Reproduce with:

```
npm pack markdown-it@14.1.0 js-yaml@4.1.0 smol-toml@1.7.1
tar -xzf markdown-it-14.1.0.tgz package/dist/markdown-it.js
tar -xzf js-yaml-4.1.0.tgz      package/dist/js-yaml.js
tar -xzf smol-toml-1.7.1.tgz    package/dist/index.cjs   # -> smol-toml.js
```

`smol-toml` is here because Codex's hook configuration lives in real TOML —
`[[hooks.EventName]]` array-of-tables with nested `[[hooks.EventName.hooks]]` —
and a hand-rolled reader that half-understands documented table syntax reports
the wrong hooks rather than none.
