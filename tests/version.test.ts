import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

test("--version prints the package version and exits cleanly", async () => {
  const build = Bun.spawnSync([process.execPath, "run", "build"], {
    cwd: import.meta.dir + "/..",
    stderr: "pipe",
    stdout: "pipe",
  })
  expect(build.exitCode).toBe(0)

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-version-"))
  const resultPath = path.join(tempDir, "result.json")
  try {
    execFileSync(
      "node",
      [
        "-e",
        [
          'const { spawnSync } = require("node:child_process")',
          'const fs = require("node:fs")',
          'const result = spawnSync(process.execPath, ["dist/main.js", "--version"], { encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } })',
          "fs.writeFileSync(process.argv[1], JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }))",
        ].join(";"),
        resultPath,
      ],
      { cwd: import.meta.dir + "/.." },
    )

    const result = (await Bun.file(resultPath).json()) as {
      status: number
      stderr: string
      stdout: string
    }
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout.trim()).toBe("0.7.0")

    execFileSync(process.execPath, ["src/main.ts", "--version"], {
      cwd: import.meta.dir + "/..",
      stdio: "ignore",
    })
  } finally {
    fs.rmSync(tempDir, { recursive: true })
  }
})
