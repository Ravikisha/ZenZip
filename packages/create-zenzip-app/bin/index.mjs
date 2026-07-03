#!/usr/bin/env node
// create-zenzipjs-app (P6.1): scaffold a working ZenZip project in seconds.
//   npx create-zenzipjs-app my-app
//   npx create-zenzipjs-app my-app --template agent
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = ["basic", "agent", "with-fastify"];

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("-"));
const template = args.includes("--template")
  ? args[args.indexOf("--template") + 1]
  : (args.find((a) => a.startsWith("--template="))?.split("=")[1] ?? "basic");

if (!name || args.includes("--help") || args.includes("-h")) {
  console.log(`
  create-zenzipjs-app — scaffold a ZenZip project

  Usage:
    npx create-zenzipjs-app <name> [--template ${TEMPLATES.join("|")}]

  Templates:
    basic         queue + cron schedule + durable workflow + dashboard
    agent         durable AI agent with tools and a human-approval gate
    with-fastify  Fastify HTTP API triggering durable workflows
`);
  process.exit(name ? 0 : 1);
}
if (!TEMPLATES.includes(template)) {
  console.error(`unknown template "${template}" — pick one of: ${TEMPLATES.join(", ")}`);
  process.exit(1);
}
if (!/^[a-z0-9-_.]+$/i.test(name)) {
  console.error(`invalid project name "${name}"`);
  process.exit(1);
}

const target = resolve(process.cwd(), name);
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`directory "${name}" exists and is not empty`);
  process.exit(1);
}

const templateDir = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", template);
mkdirSync(target, { recursive: true });
cpSync(templateDir, target, { recursive: true });

// Stamp the project name + fix files npm can't ship verbatim.
const pkgPath = join(target, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = name.toLowerCase();
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
const gitignore = join(target, "_gitignore");
if (existsSync(gitignore)) {
  cpSync(gitignore, join(target, ".gitignore"));
  // leave _gitignore harmlessly; rm not critical
}

console.log(`
  ✔ created ${name} (template: ${template})

  Next:
    cd ${name}
    npm install
    npm run dev

  Then open the dashboard at http://127.0.0.1:4100
  Kill the process mid-run and restart it — everything resumes.
`);
