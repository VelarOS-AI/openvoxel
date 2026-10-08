import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {buildCreativePreviewAssets} from "../tools/creative-preview-assets.mjs";

test("installed block models produce unique transparent inventory previews including extension packs", async () => {
  const previews = await buildCreativePreviewAssets();
  const names = new Set(previews.map(item => item.previewName));
  assert.equal(names.size, previews.length);
  assert.ok(previews.length >= 100);
  for (const name of ["openvoxel--dirt", "openvoxel--oak-log", "berries--blueberry-bush", "gourds--watermelon", "botanical--bamboo"]) {
    assert.ok(names.has(name), `Missing ${name}`);
  }
  for (const preview of previews) {
    const {data, info} = await sharp(preview.bytes).raw().toBuffer({resolveWithObject: true});
    assert.deepEqual([info.width, info.height, info.channels], [96, 96, 4]);
    assert.equal(data[3], 0, `${preview.previewName}: transparent margin`);
    if (preview.previewName === "botanical--sunflower-head") {
      let petals = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] > 110 && data[i + 1] > 70 && data[i + 2] < data[i + 1] * 0.6) petals++;
      assert.ok(petals > 80, "Sunflower preview must include its flower attachment");
    }
    let solid = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) solid++;
    assert.ok(solid > 20 && solid < 8500, `${preview.previewName}: model silhouette (${solid})`);
  }
});
