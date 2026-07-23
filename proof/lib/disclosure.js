"use strict";

// Representativeness disclosure (component 3). Printed on EVERY report. States
// what the number does and does not license, so a tight CI can never be mistaken
// for general validity. proof is never framed as a scoreboard — it is a
// directional decision instrument, not a leaderboard (spec §5.4).

function disclosure(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const n = list.length;
  const types = [...new Set(list.map((t) => t.type || "unspecified"))];
  const typeList = types.length ? types.join(", ") : "unspecified";
  const thin = types.length <= 1;
  const head = `This verdict covers ${n} task${n === 1 ? "" : "s"} of type ${typeList}; it is directional for ${thin ? "this task type" : "these task types"}, not general.`;
  const tail = thin
    ? " A single-type set measures one behavior — read the lift as evidence about that behavior, not about the config overall."
    : "";
  return head + tail;
}

module.exports = { disclosure };
