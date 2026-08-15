import { test } from "node:test";
import assert from "node:assert/strict";
import { HERO_WGSL } from "../webgpu-shaders.js";
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