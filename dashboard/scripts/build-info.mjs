import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Stamp the build once, into a file both halves read.
 *
 * `next.config.mjs` is evaluated whenever the config is loaded — at build, and again when the server
 * starts — so a timestamp computed there gives the page and the health probe different answers, and a
 * screenshot of a bug then names a build that never existed.
 */
/**
 * Where the commit came from, if anywhere. Platforms name this differently and a Docker build sees no
 * git, so the source is recorded alongside the value: a footer with no commit is otherwise
 * indistinguishable from a platform passing the variable under a name this does not read.
 */
const COMMIT_VARS = ["SOURCE_COMMIT", "GIT_SHA", "GIT_COMMIT_SHA", "COMMIT_SHA", "GITHUB_SHA"];

function sha() {
  for (const name of COMMIT_VARS) {
    const value = (process.env[name] ?? "").trim();
    if (value) return { sha: value.slice(0, 7), from: name };
  }
  try {
    return {
      sha: execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim(),
      from: "git",
    };
  } catch {
    // A gitless build context, e.g. an image built from an archive with none of these set.
    return { sha: "", from: "none" };
  }
}

const found = sha();
const info = {
  sha: found.sha,
  shaFrom: found.from,
  builtAt: `${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`,
};
const out = fileURLToPath(new URL("../lib/build-info.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`);
console.log(`build-info · ${info.sha || "no sha"} (${info.shaFrom}) · ${info.builtAt}`);
