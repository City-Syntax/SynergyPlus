#!/usr/bin/env node
/**
 * Finds utility classes that reference a design token which no longer exists.
 *
 * Tailwind v4 resolves `bg-foo` from `--color-foo` in `@theme`. When that
 * variable is absent the class silently emits nothing: no build error, no type
 * error, no visual clue beyond an unstyled element. That makes token renames
 * quietly destructive, so this runs as a gate.
 *
 * Ported from urbanflow-monorepo/scripts/check-orphan-theme-classes.mjs with
 * the theme path and scan roots adapted to this portal.
 *
 * It is deliberately conservative: it only inspects namespaces the theme
 * actually defines (colour, text, shadow, radius) and only flags a class whose
 * prefix is one we own. Unknown prefixes are left alone rather than guessed at.
 *
 * Usage: node scripts/check-orphan-theme-classes.mjs [--json]
 * Exits 1 if any orphan is found.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const THEME = join(ROOT, 'src/app/globals.css');
const SCAN_DIRS = ['src'];
const EXTS = new Set(['.ts', '.tsx', '.css', '.html']);
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.next']);

const IGNORE_FILES = new Set([]);

/** Namespaces Tailwind derives utilities from, and the class prefixes that read them. */
const NAMESPACES = [
  {
    varPrefix: '--color-',
    prefixes: [
      'text',
      'bg',
      'border',
      'fill',
      'stroke',
      'ring',
      'outline',
      'decoration',
      'shadow',
      'accent',
      'caret',
      'divide',
      'from',
      'via',
      'to',
      'placeholder',
    ],
  },
  { varPrefix: '--text-', prefixes: ['text'] },
  { varPrefix: '--shadow-', prefixes: ['shadow'] },
  { varPrefix: '--radius-', prefixes: ['rounded'] },
];

/** Suffixes Tailwind ships for every utility, regardless of the theme. */
const UNIVERSAL = new Set([
  'inherit',
  'current',
  'transparent',
  'auto',
  'none',
  'initial',
  'px',
]);

/**
 * Per-prefix builtin suffixes. A class is only an orphan when its suffix is
 * neither a theme token nor one of these -- otherwise we would flag Tailwind's
 * own `border-b`, `rounded-md`, `ring-2` and friends.
 */
const PREFIX_BUILTINS = {
  border: [
    't',
    'r',
    'b',
    'l',
    'x',
    'y',
    's',
    'e',
    'inline',
    'block',
    'solid',
    'dashed',
    'dotted',
    'double',
    'hidden',
    'collapse',
    'separate',
    'spacing',
  ],
  divide: ['x', 'y', 'solid', 'dashed', 'dotted', 'double', 'reverse'],
  ring: ['inset', 'offset'],
  outline: ['offset', 'solid', 'dashed', 'dotted', 'double', 'hidden'],
  shadow: ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', 'inner'],
  rounded: [
    'xs',
    'sm',
    'md',
    'lg',
    'xl',
    '2xl',
    '3xl',
    '4xl',
    't',
    'r',
    'b',
    'l',
    'tl',
    'tr',
    'br',
    'bl',
    's',
    'e',
    'ss',
    'se',
    'es',
    'ee',
  ],
  text: [
    'xs',
    'sm',
    'base',
    'lg',
    'xl',
    '2xl',
    '3xl',
    '4xl',
    '5xl',
    '6xl',
    '7xl',
    '8xl',
    '9xl',
    'left',
    'right',
    'center',
    'justify',
    'start',
    'end',
    'wrap',
    'nowrap',
    'balance',
    'pretty',
    'clip',
    'ellipsis',
  ],
  decoration: [
    'solid',
    'dashed',
    'dotted',
    'double',
    'wavy',
    'slice',
    'clone',
    'from-font',
  ],
  stroke: [],
  fill: [],
  bg: [
    'fixed',
    'local',
    'scroll',
    'clip',
    'origin',
    'top',
    'bottom',
    'left',
    'right',
    'center',
    'repeat',
    'no-repeat',
    'cover',
    'contain',
    'blend',
    'linear',
    'radial',
    'conic',
    'position',
    'size',
    'image',
  ],
  accent: [],
  caret: [],
  placeholder: [],
  from: [],
  via: [],
  to: [],
};

/** Side/corner segments that may sit between the prefix and the value:
 *  `rounded-t-lg`, `border-b-0`, `divide-y-2`, `rounded-tl-xl`. */
const SIDES = [
  't',
  'r',
  'b',
  'l',
  'x',
  'y',
  's',
  'e',
  'tl',
  'tr',
  'br',
  'bl',
  'ss',
  'se',
  'es',
  'ee',
  'offset',
];

/**
 * Prefixes with a built-in NUMERIC scale, where `border-2` and `from-50%` are
 * widths and percentages rather than token lookups. This list has to be
 * explicit: Tailwind's shadow scale is named, so `shadow-200` is a theme
 * lookup like any other -- exactly the orphan this gate exists to find.
 */
const NUMERIC_SCALE = new Set([
  'border',
  'ring',
  'divide',
  'outline',
  'decoration',
  'stroke',
  'from',
  'via',
  'to',
]);

function isBuiltin(prefix, name) {
  if (UNIVERSAL.has(name)) return true;
  // Arbitrary values anywhere in the value (`rounded-t-[6px]`).
  if (name.includes('[')) return true;
  if (NUMERIC_SCALE.has(prefix) && /^\d/.test(name)) return true;
  if ((PREFIX_BUILTINS[prefix] ?? []).includes(name)) return true;
  // Retry once with a leading side segment stripped.
  const dash = name.indexOf('-');
  if (dash > 0 && SIDES.includes(name.slice(0, dash))) {
    return isBuiltin(prefix, name.slice(dash + 1));
  }
  return false;
}

function readTheme() {
  const css = readFileSync(THEME, 'utf-8');
  const defined = new Set();
  for (const m of css.matchAll(/^\s*(--[a-z0-9-]+):/gm)) defined.add(m[1]);
  // A paired sub-property like `--text-x--line-height` implies `--text-x`.
  for (const name of [...defined]) {
    const base = name.replace(
      /--(line-height|letter-spacing|font-weight)$/,
      ''
    );
    if (base !== name) defined.add(base);
  }
  return defined;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (EXTS.has(entry.slice(entry.lastIndexOf('.')))) yield full;
  }
}

/** Strip variants (`hover:`, `md:`, `group-hover:`) and the `!` important flag. */
function bareUtility(token) {
  const withoutVariants = token.slice(token.lastIndexOf(':') + 1);
  return withoutVariants.replace(/^!/, '').replace(/!$/, '');
}

function classify(bare, defined) {
  let candidate = null;
  for (const { varPrefix, prefixes } of NAMESPACES) {
    for (const prefix of prefixes) {
      if (!bare.startsWith(prefix + '-')) continue;
      const rest = bare.slice(prefix.length + 1);
      // Arbitrary values (`bg-[#fff]`) and opacity modifiers (`bg-x/50`) are fine.
      if (!rest || rest.startsWith('[')) return null;
      const name = rest.split('/')[0];
      if (isBuiltin(prefix, name)) return null;
      if (defined.has(varPrefix + name)) return null; // resolves against the theme
      // A side segment may sit between the prefix and a theme value
      // (`rounded-l-full` reads `--radius-full`), so retry without it.
      const dash = name.indexOf('-');
      if (dash > 0 && SIDES.includes(name.slice(0, dash))) {
        if (defined.has(varPrefix + name.slice(dash + 1))) return null;
      }
      // Remember it, but keep looking: `text-` reads both --color-* and --text-*,
      // so a miss on one namespace is not yet a miss overall.
      candidate ??= { prefix, name, wanted: varPrefix + name };
    }
  }
  return candidate;
}

/**
 * Comments are stripped first. Doc comments routinely quote class names in
 * backticks (`bg-fill-hover`), which the template-literal pattern below would
 * otherwise read as real usage -- so documenting a token would break the gate.
 */
function stripComments(src) {
  return (
    src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // Leading boundary guard keeps `https://` and other in-string `//` intact.
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
  );
}

/**
 * A template literal's `${...}` spans are code, not class text -- but the
 * strings *inside* them are usually the conditional half of a class
 * expression. Split the static chunks from the expressions and rescan the
 * expressions, so each side is classified on its own.
 */
function* templateChunks(raw) {
  let i = 0;
  while (i < raw.length) {
    const open = raw.indexOf('${', i);
    if (open === -1) {
      yield raw.slice(i);
      return;
    }
    yield raw.slice(i, open);
    let depth = 1;
    let j = open + 2;
    for (; j < raw.length && depth > 0; j++) {
      if (raw[j] === '{') depth++;
      else if (raw[j] === '}') depth--;
    }
    for (const m of raw
      .slice(open + 2, j - 1)
      .matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)) {
      const hit = m[1] ?? m[2];
      if (hit) yield hit;
    }
    i = j;
  }
}

function* stringLiterals(src, file) {
  const isStyleFile = file.endsWith('.css') || file.endsWith('.html');
  const body = isStyleFile ? src : stripComments(src);
  const pattern = isStyleFile
    ? /(?:class|className)\s*=\s*"([^"]*)"|@apply\s+([^;]*);/g
    : /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/g;
  for (const m of body.matchAll(pattern)) {
    if (!isStyleFile && m[3] !== undefined) {
      yield* templateChunks(m[3]);
      continue;
    }
    const hit = m[1] ?? m[2] ?? m[3];
    if (hit) yield hit;
  }
}

/** Identifiers that live in strings but are not utility classes. Empty today;
 *  add entries here when a non-class string trips the scanner. */
const NOT_CLASSES = new Set([]);

const defined = readTheme();
const orphans = new Map();

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    if (IGNORE_FILES.has(relative(ROOT, file))) continue;
    const src = readFileSync(file, 'utf-8');
    for (const literal of stringLiterals(src, file)) {
      for (const raw of literal.split(/\s+/)) {
        if (!raw) continue;
        const bare = bareUtility(raw);
        // Utility classes are lowercase; anything camelCased is a JS identifier.
        if (/[A-Z]/.test(bare) || NOT_CLASSES.has(bare)) continue;
        // Quote-matching artifacts: this file's code-sample template literals
        // contain backslashes, which defeats the backtick pattern and lets a
        // "string" span into JSX syntax. No real class contains these chars.
        if (/["'<>=(){}]/.test(bare)) continue;
        const hit = classify(bare, defined);
        if (!hit) continue;
        if (!orphans.has(bare))
          orphans.set(bare, { ...hit, count: 0, files: new Set() });
        const rec = orphans.get(bare);
        rec.count++;
        rec.files.add(relative(ROOT, file));
      }
    }
  }
}

const sorted = [...orphans.entries()].sort((a, b) => b[1].count - a[1].count);

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      sorted.map(([cls, r]) => ({
        class: cls,
        wanted: r.wanted,
        count: r.count,
        files: [...r.files],
      })),
      null,
      2
    )
  );
} else if (sorted.length === 0) {
  console.log('No orphaned theme utility classes.');
} else {
  console.error(
    `${sorted.length} orphaned utility class(es) - these emit no CSS:\n`
  );
  for (const [cls, r] of sorted) {
    console.error(
      `  ${cls.padEnd(34)} ${String(r.count).padStart(4)}x  (needs ${r.wanted})`
    );
    for (const f of [...r.files].slice(0, 3)) console.error(`      ${f}`);
    if (r.files.size > 3)
      console.error(`      ... and ${r.files.size - 3} more file(s)`);
  }
}

process.exit(sorted.length === 0 ? 0 : 1);
