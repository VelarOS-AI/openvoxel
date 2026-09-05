import {mkdir, readFile, readdir, unlink, writeFile} from "node:fs/promises";
import {basename, dirname} from "node:path";
import { buildResourcePack, paths } from "./resource-pack.mjs";

async function writeChanged(path, value) {
  let current = null;
  try {
    current = await readFile(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const next = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (current !== null && current.equals(next)) return;
  await writeFile(path, next);
}

const output = await buildResourcePack();
await mkdir(dirname(paths.artifact), {recursive: true});
const bankRoot = dirname(paths.bankImage("opaque", "albedo"));
await mkdir(bankRoot, {recursive: true});
const expectedBankFiles = new Set(output.bankImages.flatMap((bank) => ["albedo", "normal", "material", "emissive"]
  .map((channel) => basename(paths.bankImage(bank.role, channel)))));
for (const entry of await readdir(bankRoot, {withFileTypes: true})) {
  if (entry.isFile() && entry.name.endsWith(".png") && !expectedBankFiles.has(entry.name)) {
    await unlink(`${bankRoot}/${entry.name}`);
  }
}
await Promise.all([
  writeChanged(paths.artifact, output.artifactText),
  writeChanged(paths.audit, output.auditText),
  ...output.bankImages.flatMap((bank) => [
    writeChanged(paths.bankImage(bank.role, "albedo"), bank.albedoBytes),
    writeChanged(paths.bankImage(bank.role, "normal"), bank.normalBytes),
    writeChanged(paths.bankImage(bank.role, "material"), bank.materialBytes),
    writeChanged(paths.bankImage(bank.role, "emissive"), bank.emissiveBytes),
  ]),
]);
