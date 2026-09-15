import { strict as assert } from "node:assert";
import { cacheHitDenom, cacheHitPct, aggregateHit } from "../extensions/cache-guardian.ts";
import { isolateCacheEnv } from "./helpers.mjs";

isolateCacheEnv();

// 1. Real Pi data shape: promptTokens=1000, cached=800 -> Pi usage: {input: 200, cacheRead: 800, cacheWrite: 0}
// Denominator = input + cacheRead + cacheWrite = 1000, hitRate = 800/1000 = 80%
{
  const usage = { input: 200, cacheRead: 800, cacheWrite: 0 };
  assert.equal(cacheHitDenom(usage), 1000);
  assert.equal(cacheHitPct(usage), 80);

  // Number argument overload
  assert.equal(cacheHitDenom(200, 800, 0), 1000);
  assert.equal(cacheHitPct(200, 800, 0), 80);
}

// 2. Real Pi data shape with cacheWrite: {input: 200, cacheRead: 800, cacheWrite: 50}
// Denominator = 200 + 800 + 50 = 1050, hitRate = Math.round((800 / 1050) * 100) = 76%
{
  const usage = { input: 200, cacheRead: 800, cacheWrite: 50 };
  assert.equal(cacheHitDenom(usage), 1050);
  assert.equal(cacheHitPct(usage), 76);

  // Number argument overload
  assert.equal(cacheHitDenom(200, 800, 50), 1050);
  assert.equal(cacheHitPct(200, 800, 50), 76);
}

// 3. cacheRead = 0 and denom > 0 -> 0%
{
  const zeroRead = { input: 1000, cacheRead: 0, cacheWrite: 0 };
  assert.equal(cacheHitDenom(zeroRead), 1000);
  assert.equal(cacheHitPct(zeroRead), 0);

  const zeroReadWithWrite = { input: 500, cacheRead: 0, cacheWrite: 50 };
  assert.equal(cacheHitDenom(zeroReadWithWrite), 550);
  assert.equal(cacheHitPct(zeroReadWithWrite), 0);
}

// 4. All zeros / empty usage / denom <= 0 -> null, not NaN
{
  const zeroDenomUsage = { input: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(cacheHitDenom(zeroDenomUsage), 0);
  assert.equal(cacheHitPct(zeroDenomUsage), null);

  assert.equal(cacheHitDenom({}), 0);
  assert.equal(cacheHitPct({}), null);

  // Number argument overload
  assert.equal(cacheHitDenom(0, 0, 0), 0);
  assert.equal(cacheHitPct(0, 0, 0), null);
}

// 5. Old formula bug cases (cacheRead / input is wrong):
// Case A: {input: 1000, cacheRead: 800, cacheWrite: 0}
// NOTE: cacheRead/input 是错的 (would wrongly calculate 800/1000 = 80%).
// Since Pi's input is net uncached input (1000), total tokens = 1000 + 800 = 1800.
// Correct hit rate is 800 / 1800 = 44%.
{
  const usage = { input: 1000, cacheRead: 800, cacheWrite: 0 };
  assert.equal(cacheHitDenom(usage), 1800);
  assert.equal(cacheHitPct(usage), 44);
}

// Case B: {input: 1000, cacheRead: 9000, cacheWrite: 0}
// NOTE: cacheRead/input 是错的 (would wrongly calculate 9000/1000 = 900% > 100%).
// Total tokens = 1000 + 9000 = 10000. Correct hit rate is 9000 / 10000 = 90%.
{
  const usage = { input: 1000, cacheRead: 9000, cacheWrite: 0 };
  assert.equal(cacheHitDenom(usage), 10000);
  assert.equal(cacheHitPct(usage), 90);
}

// 6. Multi-turn aggregation using exported aggregateHit
// Turn 1: {input: 200, cacheRead: 800, cacheWrite: 0} -> denom1 = 1000, read1 = 800 (80%)
// Turn 2: {input: 200, cacheRead: 800, cacheWrite: 50} -> denom2 = 1050, read2 = 800 (76%)
// Total read = 1600, total denom = 2050 -> aggregateHit(1600, 2050) = 78% (Math.round((1600 / 2050) * 100) = 78)
// Reverting to old formula (where input was wrongly assumed gross) would cause test failure.
{
  const turn1 = { input: 200, cacheRead: 800, cacheWrite: 0 };
  const denom1 = cacheHitDenom(turn1);
  const hitPct1 = cacheHitPct(turn1);

  const turn2 = { input: 200, cacheRead: 800, cacheWrite: 50 };
  const denom2 = cacheHitDenom(turn2);
  const hitPct2 = cacheHitPct(turn2);

  assert.equal(denom1, 1000);
  assert.equal(hitPct1, 80);
  assert.equal(denom2, 1050);
  assert.equal(hitPct2, 76);

  const totalCacheRead = turn1.cacheRead + turn2.cacheRead;
  const totalDenom = denom1 + denom2;
  const aggHit = aggregateHit(totalCacheRead, totalDenom);

  assert.equal(totalCacheRead, 1600);
  assert.equal(totalDenom, 2050);
  assert.equal(aggHit, 78);
}

// 7. Footer formatting & truncation verification
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { truncateFooter, formatHerdsmanStatus, formatWindowSize } from "../extensions/cache-guardian.ts";

{
  // 7a. formatWindowSize tests
  // Binary powers
  assert.equal(formatWindowSize(1048576), "1M");
  assert.equal(formatWindowSize(2097152), "2M");
  assert.equal(formatWindowSize(524288), "512K");
  assert.equal(formatWindowSize(131072), "128K");
  assert.equal(formatWindowSize(65536), "64K");

  // Decimal powers / multiples
  assert.equal(formatWindowSize(1000000), "1M");
  assert.equal(formatWindowSize(2000000), "2M");
  assert.equal(formatWindowSize(500000), "500K");
  assert.equal(formatWindowSize(128000), "128K");
  assert.equal(formatWindowSize(1500000), "1500K");
  assert.equal(formatWindowSize(1000), "1K");

  // Non-divisible boundaries & edge cases
  assert.equal(formatWindowSize(1000001), "1000001");
  assert.equal(formatWindowSize(999999), "999999");
  assert.equal(formatWindowSize(999), "999");
  assert.equal(formatWindowSize(1001), "1001");
  assert.equal(formatWindowSize(0), "0");
  assert.equal(formatWindowSize(-1000), "-1000");

  // 7b. Herdsman status formatting tests
  // With numeric results -> "N Up"
  assert.equal(formatHerdsmanStatus("◆ Herdsman · 1 agent update"), "1 Up");
  assert.equal(formatHerdsmanStatus("◆ Herdsman · 2 agent updates"), "2 Up");
  assert.equal(formatHerdsmanStatus("◆ Herdsman · 3 agent updates"), "3 Up");
  assert.equal(formatHerdsmanStatus("Shepherd · 2 agent updates"), "2 Up");
  assert.equal(formatHerdsmanStatus("1 agent update"), "1 Up");
  assert.equal(formatHerdsmanStatus("2 updates"), "2 Up");
  assert.equal(formatHerdsmanStatus("1 UP"), "1 Up");
  assert.equal(formatHerdsmanStatus("5"), "5 Up");
  // Running with no return results -> returns "On"
  assert.equal(formatHerdsmanStatus("◆ Herdsman"), "On");
  assert.equal(formatHerdsmanStatus("Herdsman"), "On");
  assert.equal(formatHerdsmanStatus("◇ Herdsman · reconnecting"), "On");
  assert.equal(formatHerdsmanStatus("Shepherd"), "On");
  // Not running / empty / undefined / pure whitespace -> returns null (not displayed)
  assert.equal(formatHerdsmanStatus(""), null);
  assert.equal(formatHerdsmanStatus("   "), null);
  assert.equal(formatHerdsmanStatus(undefined), null);

  const dummyTheme = {
    fg: (style, text) => (style === "dim" ? `\x1b[2m${text}\x1b[22m` : text),
  };
  // 1. Running with 2 results: ● 2 Up | ◆ 85% | ▲ 42%/1M | ■ deepseek-v4-flash
  const fullLine = "\x1b[2m●\x1b[22m 2 Up \x1b[2m|\x1b[22m \x1b[2m◆\x1b[22m 85% \x1b[2m|\x1b[22m \x1b[2m▲\x1b[22m 42%/1M \x1b[2m|\x1b[22m \x1b[2m■\x1b[22m deepseek-v4-flash";
  const fullWidth = visibleWidth(fullLine);

  // 2. Running without results: ● On | ◆ 85% | ▲ 42%/1M | ■ deepseek-v4-flash
  const onLine = "\x1b[2m●\x1b[22m On \x1b[2m|\x1b[22m \x1b[2m◆\x1b[22m 85% \x1b[2m|\x1b[22m \x1b[2m▲\x1b[22m 42%/1M \x1b[2m|\x1b[22m \x1b[2m■\x1b[22m deepseek-v4-flash";
  assert.equal(truncateFooter(onLine, 100, dummyTheme), onLine);

  // 3. Herdsman not running: herdsman hidden, ◆ 85% | ▲ 42%/1M | ■ deepseek-v4-flash
  const notRunningLine = "\x1b[2m◆\x1b[22m 85% \x1b[2m|\x1b[22m \x1b[2m▲\x1b[22m 42%/1M \x1b[2m|\x1b[22m \x1b[2m■\x1b[22m deepseek-v4-flash";
  assert.equal(truncateFooter(notRunningLine, 100, dummyTheme), notRunningLine);

  // Ample width
  const wide = truncateFooter(fullLine, 100, dummyTheme);
  assert.equal(wide, fullLine);
  assert.equal(visibleWidth(wide), fullWidth);

  // Exact width
  const exact = truncateFooter(fullLine, fullWidth, dummyTheme);
  assert.equal(exact, fullLine);
  assert.equal(visibleWidth(exact), fullWidth);

  // Narrow width truncation: output visibleWidth never exceeds target width
  for (const w of [50, 40, 30, 20, 15, 10, 5, 2, 1]) {
    const res = truncateFooter(fullLine, w, dummyTheme);
    const vw = visibleWidth(res);
    assert.ok(vw <= w, `width=${w} expected vw <= ${w}, got ${vw}`);
    assert.ok(!res.includes("\n"), "footer must never contain newlines");
  }

  // Edge cases: 0 and negative width
  assert.equal(truncateFooter(fullLine, 0, dummyTheme), "");
  assert.equal(truncateFooter(fullLine, -5, dummyTheme), "");
  assert.equal(truncateFooter("", 10, dummyTheme), "");

  // Plain string fallback
  const plain = "Hello world from cache-guardian footer";
  const res = truncateFooter(plain, 10);
  assert.ok(visibleWidth(res) <= 10);
  assert.ok(stripTerminalSequences(res).endsWith("…") || stripTerminalSequences(res).endsWith("..."));
}

console.log("All hit-rate and footer tests passed!");


