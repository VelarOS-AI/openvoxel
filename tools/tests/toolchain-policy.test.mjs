import assert from "node:assert/strict";
import test from "node:test";
import { installedToolchainViolation, toolchainPinViolations } from "../architecture/policy.mjs";

test("every toolchain dependency field uses the exact root CLI release", () => {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(toolchainPinViolations({ [field]: { "@velarscript/web": "0.32.0" } }, "0.32.0"), []);
    for (const version of ["0.30.1", "^0.32.0", "~0.32.0", "latest"]) {
      assert.equal(toolchainPinViolations({ [field]: { "@velarscript/web": version } }, "0.32.0").length, 1);
    }
  }
});

test("installed lockfile toolchain versions must match the root CLI", () => {
  assert.equal(installedToolchainViolation("@velarscript/compiler", { version: "0.32.0" }, "0.32.0"), null);
  assert.match(installedToolchainViolation("@velarscript/compiler", { version: "0.30.1" }, "0.32.0"), /must match/);
  assert.match(installedToolchainViolation("@velarscript/compiler", {}, "0.32.0"), /must match/);
});

test("Labs and other dependencies keep their independent version lines", () => {
  assert.deepEqual(toolchainPinViolations({ dependencies: { "@velarscript-labs/sqlite": "0.3.4", playwright: "1.62.1" } }, "0.32.0"), []);
  assert.equal(installedToolchainViolation("@velarscript-labs/sqlite", { version: "0.3.4" }, "0.32.0"), null);
});
