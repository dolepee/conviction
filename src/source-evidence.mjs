import { execFileSync } from "node:child_process";

export function localSourceEvidence({
  cwd,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (!cwd) throw new TypeError("source evidence cwd is required");
  const run = (args) => String(execFileSyncImpl("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }) || "").trim();
  const commit = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain", "--untracked-files=no"]);
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("source evidence commit is invalid");
  }
  return Object.freeze({
    commit: commit.toLowerCase(),
    trackedTreeClean: status === "",
  });
}
