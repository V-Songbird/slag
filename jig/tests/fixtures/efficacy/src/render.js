"use strict";

// Fixture: near-miss negative B for silent-catch. Never executed.
//
// The violating shape appears five times below and not once as code: in a line
// comment, in a block comment, in a double-quoted string, in a template
// literal, and in a regular expression. This is the file that measures comment
// and string handling, which is where the false positives live.
//
// This line holds the literal text catch (err) { } on purpose.

/* And this block comment holds catch {} too. */

const EMPTY_CATCH = "catch (err) { }";
const BARE_CATCH = `catch {}`;
const EMPTY_CATCH_RE = /catch\s*(\([^)]*\))?\s*\{\s*\}/;

function describeSwallow(source) {
  return EMPTY_CATCH_RE.test(source) ? EMPTY_CATCH : BARE_CATCH;
}

module.exports = { EMPTY_CATCH, BARE_CATCH, EMPTY_CATCH_RE, describeSwallow };
