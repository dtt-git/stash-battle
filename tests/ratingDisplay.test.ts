import assert from "node:assert/strict";
import { test } from "node:test";
import { exampleRating, formatRating, parseRatingSystem, ratingStarts, ratingValue, scaleMarks } from "../src/ratingDisplay";

const decimal = parseRatingSystem({ ratingSystemOptions: { type: "decimal", starPrecision: "tenth" } });
const full = parseRatingSystem({ ratingSystemOptions: { type: "stars", starPrecision: "full" } });
const half = parseRatingSystem({ ratingSystemOptions: { type: "stars", starPrecision: "half" } });

test("Stash's rating system is read from configuration.ui, defaulting to whole stars", () => {
  assert.deepEqual(decimal, { type: "decimal", starStep: 0.1 });
  assert.deepEqual(parseRatingSystem({ ratingSystemOptions: { type: "stars", starPrecision: "quarter" } }), { type: "stars", starStep: 0.25 });
  assert.deepEqual(parseRatingSystem(null), { type: "stars", starStep: 1 });
  assert.deepEqual(parseRatingSystem({}), { type: "stars", starStep: 1 });
});

test("ratings show as Stash shows them", () => {
  assert.equal(formatRating(74, false, decimal), "7.4");
  assert.equal(formatRating(100, false, decimal), "10.0");
  assert.equal(formatRating(1, false, decimal), "0.1");
  assert.equal(formatRating(74, false, half), "3.5★");
  assert.equal(formatRating(74, false, full), "4★");
  assert.equal(formatRating(100, true, full), "5 stars");
  assert.equal(formatRating(20, true, full), "1 star");
  // A set rating is never 0 stars
  assert.equal(ratingValue(1, full), "1");
  assert.equal(ratingValue(1, half), "0.5");
});

test("description examples are ratings the system can show", () => {
  assert.equal(exampleRating(50, decimal), 50);
  assert.equal(exampleRating(50, half), 50);
  assert.equal(exampleRating(50, full), 40);
  assert.equal(exampleRating(90, full), 80);
  assert.equal(exampleRating(90, half), 90);
});

test("sentences and the Stats scale read right on each system", () => {
  assert.equal(ratingStarts(50, decimal), "a 5.0 starts");
  assert.equal(ratingStarts(50, half), "2.5 stars start");
  assert.equal(ratingStarts(20, full), "1 star starts");
  // One mark per star on star systems, so whole stars never repeat a label
  assert.deepEqual(scaleMarks(full).map((r) => formatRating(r, false, full)), ["1★", "2★", "3★", "4★", "5★"]);
  assert.deepEqual(scaleMarks(decimal).map((r) => formatRating(r, false, decimal)), ["0.1", "2.5", "5.0", "7.5", "10.0"]);
});
