import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HERO_WGSL,
  STAR_SHARP_BY_SCALE,
  STAR_BRIGHT_BY_SCALE,
  wgslSelectByScale
} from "../webgpu-shaders.js";
import { UNIFORM_OFFSETS } from "../webgpu-engine.js";

test("WGSL entry points are present", () => {
  assert.ok(HERO_WGSL.includes("@vertex"), "missing vertex entry");
  assert.ok(HERO_WGSL.includes("@fragment"), "missing fragment entry");
  assert.ok(HERO_WGSL.includes("@group(0) @binding(0)"), "missing uniform binding");
  assert.ok(HERO_WGSL.includes("var<uniform> u"), "missing uniform declaration");
});

test("WGSL struct members exactly match the JS uniform layout", () => {
  const match = HERO_WGSL.match(/struct U\s*\{([\s\S]*?)\}/);
  assert.ok(match, "struct U not found");
  const members = match[1]
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(":")[0].trim())
    .filter((name) => !name.startsWith("_p")); // explicit std140 padding members
  assert.deepEqual(members, Object.keys(UNIFORM_OFFSETS));
});

function hasTopLevelComma(text) {
  let depth = 0;
  for (const character of text) {
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) return true;
  }
  return false;
}

function findCommaLetStatements(source) {
  const offenders = [];
  let depth = 0;
  let statement = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === ";" && depth === 0) {
      if (statement.includes("let ") && hasTopLevelComma(statement)) {
        offenders.push(statement.trim());
      }
      statement = "";
      continue;
    }
    statement += character;
  }
  return offenders;
}

test("no comma-separated let declarations (WGSL forbids them)", () => {
  assert.deepEqual(findCommaLetStatements(HERO_WGSL), []);
});

test("shader braces balance", () => {
  let depth = 0;
  for (const character of HERO_WGSL) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    assert.ok(depth >= 0, "unbalanced closing brace");
  }
  assert.equal(depth, 0);
});

test("WGSL is a non-trivial port (not an empty stub)", () => {
  assert.ok(HERO_WGSL.length > 5000, "shader unexpectedly short");
});

// ── regression: the bright-star scale selects. The GLSL reference is
//   sharp  = (s == 0 ? 260.0 : (s == 1 ? 700.0 : 1600.0))
//   bright = (s == 0 ? 1.7   : (s == 1 ? 0.9   : 0.5))
// The WGSL port nested select() the wrong way around at one point (s == 0
// produced the s == 2 value), so these tests pin the tables AND the actual
// select expression emitted into the shader source.

test("star-scale tables match the GLSL reference values", () => {
  assert.deepEqual(STAR_SHARP_BY_SCALE, [260, 700, 1600]);
  assert.deepEqual(STAR_BRIGHT_BY_SCALE, [1.7, 0.9, 0.5]);
});

// Evaluate the exact select() grammar emitted by wgslSelectByScale:
//   select(select(v2, v1, s == 1u), v0, s == 0u)
// with WGSL semantics select(falseValue, trueValue, condition).
function evalStarSelect(expression, s) {
  let index = 0;
  const source = expression;
  function skipSpace() {
    while (source[index] === " ") index += 1;
  }
  function parseValue() {
    skipSpace();
    if (source.startsWith("select(", index)) {
      index += "select(".length;
      const falseValue = parseValue();
      skipSpace();
      index += 1; // comma
      const trueValue = parseValue();
      skipSpace();
      index += 1; // comma
      let condition;
      skipSpace();
      if (source.startsWith("s == 0u", index)) {
        index += "s == 0u".length;
        condition = (x) => x === 0;
      } else if (source.startsWith("s == 1u", index)) {
        index += "s == 1u".length;
        condition = (x) => x === 1;
      } else {
        throw new Error(`unexpected condition in select: ${expression}`);
      }
      skipSpace();
      index += 1; // closing paren
      return condition(s) ? trueValue : falseValue;
    }
    const start = index;
    while (index < source.length && /[0-9.e+-]/.test(source[index])) index += 1;
    return Number(source.slice(start, index));
  }
  return parseValue();
}

test("wgslSelectByScale maps s = 0/1/2 to sharp [260, 700, 1600]", () => {
  const expression = wgslSelectByScale(STAR_SHARP_BY_SCALE);
  for (const s of [0, 1, 2]) {
    assert.equal(evalStarSelect(expression, s), STAR_SHARP_BY_SCALE[s], `s=${s}`);
  }
});

test("wgslSelectByScale maps s = 0/1/2 to bright [1.7, 0.9, 0.5]", () => {
  const expression = wgslSelectByScale(STAR_BRIGHT_BY_SCALE);
  for (const s of [0, 1, 2]) {
    assert.equal(evalStarSelect(expression, s), STAR_BRIGHT_BY_SCALE[s], `s=${s}`);
  }
});

test("HERO_WGSL embeds the generated sharp/bright select expressions", () => {
  assert.ok(
    HERO_WGSL.includes(`let sharp = ${wgslSelectByScale(STAR_SHARP_BY_SCALE)} / sizeJit * resFac;`),
    "sharp line must use the exported select table"
  );
  assert.ok(
    HERO_WGSL.includes(`let bright = ${wgslSelectByScale(STAR_BRIGHT_BY_SCALE)} * (0.55 + 0.7 * sizeJit);`),
    "bright line must use the exported select table"
  );
});