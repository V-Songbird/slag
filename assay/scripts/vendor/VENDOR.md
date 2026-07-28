# Vendored parsers

assay parses instruction files with real parsers, and it installs nothing. Both
libraries below are committed here as their published single-file UMD dist
builds and loaded with a plain `require("./vendor/<name>.js")`. There is no
`package.json` anywhere in this plugin and no install step for a user.

**Never edit these files.** They are third-party sources reproduced verbatim,
license headers included. To move to a new version, re-download the tarball,
replace the file, and update the table below.

| Package | Version | License | Registry tarball | Integrity (`npm view <pkg>@<ver> dist.integrity`) |
| --- | --- | --- | --- | --- |
| `markdown-it` | 14.1.0 | MIT | https://registry.npmjs.org/markdown-it/-/markdown-it-14.1.0.tgz | `sha512-a54IwgWPaeBCAAsv13YgmALOF1elABB08FxO9i+r4VFk5Vl4pKokRPeX8u5TCgSsPi6ec1otfLjdOpVcgbpshg==` |
| `js-yaml` | 4.1.0 | MIT | https://registry.npmjs.org/js-yaml/-/js-yaml-4.1.0.tgz | `sha512-wpxZs9NoxZaJESJGIZTyDEaYpl0FKSA+FB9aJiyemKhMwkxQg63h4T1KJgUGHpTqPDNRcmmYLugrRjJlBtWvRA==` |

Files taken from each tarball:

- `markdown-it.js` — `package/dist/markdown-it.js` (the plain UMD build, not the
  minified one).
- `js-yaml.js` — `package/dist/js-yaml.js` (the plain UMD build, not the
  minified one).

Reproduce with:

```
npm pack markdown-it@14.1.0 js-yaml@4.1.0
tar -xzf markdown-it-14.1.0.tgz package/dist/markdown-it.js
tar -xzf js-yaml-4.1.0.tgz     package/dist/js-yaml.js
```
