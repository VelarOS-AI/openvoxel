import {dirname, join} from "node:path";

// Small JSON modules keep each texture bank below the compiler's resource limit.
// The complete artifact remains the distributable, hashed resource pack.
export function resourceModules(artifactPath, artifactText) {
  const artifact = JSON.parse(artifactText);
  const banks = artifact.textureBanks;
  const directory = dirname(artifactPath);
  const files = new Map([[join(directory, "resource-pack-metadata.json"), JSON.stringify({...artifact, textureBanks: []}) + "\n"]]);
  for (const bank of banks) {
    const text = JSON.stringify(bank) + "\n";
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error(`Texture bank ${bank.role} exceeds the JSON module limit`);
    files.set(join(directory, `texture-bank-${bank.role}.json`), text);
  }
  return files;
}
