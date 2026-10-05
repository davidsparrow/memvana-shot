import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isAutoName, nameHint, nameTerms } from "../src/names.ts";

describe("isAutoName", () => {
  const auto = [
    "Screenshot 2026-09-07 at 10.20.42 PM.png",
    "Screen Shot 2019-05-01 at 15.04.22.png",
    "CleanShot 2024-01-09 at 09.10.11@2x.png",
    "Screenshot_20240501-102213.png",
    "IMG_2041.PNG",
    "PXL_20240501_102213123.jpg",
    "image (3).png",
    "Simulator Screenshot - iPhone 15 - 2024-05-01 at 10.22.13.png",
    "3F2504E0-4F89-11D3-9A0C-0305E82C3301.png",
    "20240501_102213.jpg",
  ];
  const descriptive = [
    "classroom_note_meme.jpg",
    "exploded food infographic for GPTImage2.jpg",
    "magus__eddm_door-hanger-strip-magnets.png",
    "nelag0-jimi-hendrix-881410_1920.jpg",
    "receipt.jpg",
  ];
  for (const name of auto) test(`auto: ${name}`, () => assert.equal(isAutoName(name), true));
  for (const name of descriptive) test(`descriptive: ${name}`, () => assert.equal(isAutoName(name), false));
});

describe("nameTerms", () => {
  test("splits separators and camelCase, drops numbers and boilerplate", () => {
    assert.equal(nameTerms("Ideas/PickleballWall_v2 (1).png"), "ideas pickleball wall v2");
    assert.equal(nameTerms("magus__eddm_door-hanger-strip-magnets.png"), "magus eddm door hanger strip magnets");
    assert.equal(nameTerms("nelag0-jimi-hendrix-881410_1920.jpg"), "nelag0 jimi hendrix");
    assert.equal(nameTerms("exploded food infographic for GPTImage2.jpg"), "exploded food infographic for gpt image2");
    assert.equal(nameTerms("magbymail_postcard+mag_eddm_2.png"), "magbymail postcard mag eddm");
  });
  test("auto-generated names leave nothing behind", () => {
    assert.equal(nameTerms("Screenshot 2026-09-07 at 10.20.42 PM.png"), "");
    assert.equal(nameTerms("IMG_2041.PNG"), "");
  });
});

describe("nameHint", () => {
  test("reports file name, folder and whether the name means anything", () => {
    assert.deepEqual(nameHint("Recipes/pho-broth.png"), {
      file_name: "pho-broth.png",
      folder: "Recipes",
      name_is_descriptive: true,
    });
    assert.deepEqual(nameHint("IMG_2041.PNG"), { file_name: "IMG_2041.PNG", folder: null, name_is_descriptive: false });
  });
});
