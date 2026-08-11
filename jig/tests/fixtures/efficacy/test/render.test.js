"use strict";

// Fixture: near-miss negative B for focused-or-skipped-test. Never executed.
//
// Every name below reads like a focus or a skip and is neither: a variable
// called itOnly, a runner object with its own skip and only methods, and a
// helper whose name merely starts with describe.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { describeSwallow, EMPTY_CATCH } = require("../src/render.js");

const itOnly = true;
const runner = { skip: (name) => name, only: (name) => name };

describe("render", () => {
  it("keeps a variable named itOnly out of the pattern", () => {
    assert.equal(itOnly, true);
  });

  it("keeps a runner's own skip and only methods out of the pattern", () => {
    assert.equal(runner.skip("one"), "one");
    assert.equal(runner.only("two"), "two");
  });

  it("names the swallow it found", () => {
    assert.equal(describeSwallow("catch (e) {}"), EMPTY_CATCH);
  });
});
