import {readFile, readdir} from "node:fs/promises";
import {basename, dirname} from "node:path";
import { buildResourcePack, paths } from "./resource-pack.mjs";

const output = await buildResourcePack();
const [artifact, audit, ...bankImages] = await Promise.all([
  readFile(paths.artifact),
  readFile(paths.audit),
  ...output.bankImages.flatMap((bank) => [
    readFile(paths.bankImage(bank.role, "albedo")),
    readFile(paths.bankImage(bank.role, "normal")),
    readFile(paths.bankImage(bank.role, "material")),
    readFile(paths.bankImage(bank.role, "emissive")),
  ]),
]);
const expectedBankImages = output.bankImages.flatMap((bank) => [
  bank.albedoBytes,
  bank.normalBytes,
  bank.materialBytes,
  bank.emissiveBytes,
]);
const bankRoot = dirname(paths.bankImage("opaque", "albedo"));
const actualBankFiles = (await readdir(bankRoot, {withFileTypes: true}))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
const expectedBankFiles = output.bankImages.flatMap((bank) => ["albedo", "normal", "material", "emissive"]
  .map((channel) => basename(paths.bankImage(bank.role, channel))))
  .sort();
if (!artifact.equals(Buffer.from(output.artifactText))
  || !audit.equals(Buffer.from(output.auditText))
  || bankImages.some((value, index) => !value.equals(expectedBankImages[index]))
  || JSON.stringify(actualBankFiles) !== JSON.stringify(expectedBankFiles)) {
  throw new Error("Generated client resource pack is stale; run npm run generate --workspace @openvoxel/renderer");
}
