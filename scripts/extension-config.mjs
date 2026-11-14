#!/usr/bin/env node
/*
 * Writes extension/config.js from this repo's .env, so the server address
 * lives in an ignored file instead of the extension's source.
 *
 *   POLYMATH_URL=https://polymath.example   →   self.POLYMATH_DEFAULT_URL = "https://polymath.example";
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function readEnv(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`No .env at ${path}. Copy .env.example to .env and set POLYMATH_URL.`);
  }
  const values = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

const raw = readEnv(`${root}.env`).POLYMATH_URL;
if (!raw) throw new Error("POLYMATH_URL is not set in .env.");
const url = new URL(raw);
if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`POLYMATH_URL must be http or https: ${raw}`);

const target = `${root}extension/config.js`;
writeFileSync(
  target,
  `// Written by scripts/extension-config.mjs from .env. Not committed.\nself.POLYMATH_DEFAULT_URL = ${JSON.stringify(url.origin)};\n`,
);
console.log(`Wrote ${target}`);
