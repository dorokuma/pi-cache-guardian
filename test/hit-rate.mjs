import { strict as assert } from "node:assert";
import { cacheHitDenom, cacheHitPct, aggregateHit, normalizeUsage, computeLiveHitRates } from "../extensions/cache-guardian.ts";
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

// 8. OpenAI style usage normalization and hit rate tests
{
  // 8a. Basic OpenAI format (prompt_tokens, completion_tokens, total_tokens) without cache
  const openAiBasic = {
    prompt_tokens: 1500,
    completion_tokens: 300,
    total_tokens: 1800,
  };
  const normBasic = normalizeUsage(openAiBasic);
  assert.equal(normBasic.input, 1500);
  assert.equal(normBasic.output, 300);
  assert.equal(normBasic.totalTokens, 1800);
  assert.equal(normBasic.total, 1800);
  assert.equal(normBasic.cacheRead, 0);
  assert.equal(normBasic.cacheWrite, 0);
  assert.equal(cacheHitDenom(openAiBasic), 1500);
  assert.equal(cacheHitPct(openAiBasic), 0);

  // 8b. OpenAI format with prompt_tokens_details.cached_tokens
  const openAiCached = {
    prompt_tokens: 200,
    completion_tokens: 100,
    total_tokens: 1100,
    prompt_tokens_details: {
      cached_tokens: 800,
    },
  };
  const normCached = normalizeUsage(openAiCached);
  assert.equal(normCached.input, 200);
  assert.equal(normCached.output, 100);
  assert.equal(normCached.cacheRead, 800);
  assert.equal(normCached.cacheWrite, 0);
  assert.equal(normCached.totalTokens, 1100);
  assert.equal(cacheHitDenom(openAiCached), 1000);
  assert.equal(cacheHitPct(openAiCached), 80);

  // 8c. OpenAI format with flat cached_tokens and cache_creation_input_tokens
  const openAiMixed = {
    prompt_tokens: 200,
    completion_tokens: 50,
    total_tokens: 1100,
    cached_tokens: 800,
    cache_creation_input_tokens: 50,
  };
  const normMixed = normalizeUsage(openAiMixed);
  assert.equal(normMixed.input, 200);
  assert.equal(normMixed.output, 50);
  assert.equal(normMixed.cacheRead, 800);
  assert.equal(normMixed.cacheWrite, 50);
  assert.equal(cacheHitDenom(openAiMixed), 1050);
  assert.equal(cacheHitPct(openAiMixed), 76);

  // 8d. Standard Pi format preservation
  const piNative = {
    input: 200,
    output: 100,
    cacheRead: 800,
    cacheWrite: 50,
    totalTokens: 1150,
  };
  const normNative = normalizeUsage(piNative);
  assert.equal(normNative.input, 200);
  assert.equal(normNative.output, 100);
  assert.equal(normNative.cacheRead, 800);
  assert.equal(normNative.cacheWrite, 50);
  assert.equal(normNative.totalTokens, 1150);

  // 8e. Empty / null / undefined edge cases
  const emptyNorm = normalizeUsage({});
  assert.equal(emptyNorm.input, 0);
  assert.equal(emptyNorm.output, 0);
  assert.equal(emptyNorm.cacheRead, 0);
  assert.equal(emptyNorm.cacheWrite, 0);
  assert.equal(emptyNorm.totalTokens, 0);

  const nullNorm = normalizeUsage(null);
  assert.equal(nullNorm.input, 0);
  assert.equal(nullNorm.output, 0);
  assert.equal(nullNorm.cacheRead, 0);
  assert.equal(nullNorm.cacheWrite, 0);
  assert.equal(nullNorm.totalTokens, 0);
}

// 9. computeLiveHitRates tests
{
  // 9a. Empty / invalid entries
  assert.deepEqual(computeLiveHitRates([]), { aggregate: null, latest: null });
  assert.deepEqual(computeLiveHitRates(null), { aggregate: null, latest: null });
  assert.deepEqual(computeLiveHitRates(undefined), { aggregate: null, latest: null });
  assert.deepEqual(computeLiveHitRates([null, undefined, {}, { type: "other" }]), { aggregate: null, latest: null });

  // 9b. Single assistant message: aggregate and latest must match
  const singleEntry = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 200, cacheRead: 800, cacheWrite: 0 },
      },
    },
  ];
  // 800 / 1000 = 80%
  assert.deepEqual(computeLiveHitRates(singleEntry), { aggregate: 80, latest: 80 });

  // 9c. Multi-turn assistant messages: aggregate is cumulative, latest is newest assistant
  const multiTurnEntries = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 200, cacheRead: 800, cacheWrite: 0 }, // 80%
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 50, cacheRead: 950, cacheWrite: 0 }, // 95%
      },
    },
  ];
  // Aggregate: (800 + 950) / (1000 + 1000) = 1750 / 2000 = 87.5% -> 88%
  // Latest: 950 / 1000 = 95%
  assert.deepEqual(computeLiveHitRates(multiTurnEntries), { aggregate: 88, latest: 95 });

  // 9d. toolResult messages contribute to aggregate only, NOT latest
  const withToolResult = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 200, cacheRead: 800, cacheWrite: 0 }, // 80%
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        usage: { input: 100, cacheRead: 100, cacheWrite: 0 }, // 50%
      },
    },
  ];
  // Aggregate: (800 + 100) / (1000 + 200) = 900 / 1200 = 75%
  // Latest: 800 / 1000 = 80% (toolResult does NOT overwrite latest)
  assert.deepEqual(computeLiveHitRates(withToolResult), { aggregate: 75, latest: 80 });

  // 9e. branch_summary & compaction contribute to aggregate only, NOT latest
  const withCompactionAndBranch = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 100, cacheRead: 900, cacheWrite: 0 }, // 90%
      },
    },
    {
      type: "compaction",
      usage: { input: 50, cacheRead: 50, cacheWrite: 0 }, // 50%
    },
    {
      type: "branch_summary",
      usage: { input: 50, cacheRead: 50, cacheWrite: 0 }, // 50%
    },
  ];
  // Aggregate: (900 + 50 + 50) / (1000 + 100 + 100) = 1000 / 1200 = 83.3% -> 83%
  // Latest: 90% (unchanged by compaction/branch_summary)
  assert.deepEqual(computeLiveHitRates(withCompactionAndBranch), { aggregate: 83, latest: 90 });

  // 9f. Compaction/toolResult only (no assistant message): aggregate calculated, latest is null
  const compactionOnly = [
    {
      type: "compaction",
      usage: { input: 100, cacheRead: 300, cacheWrite: 0 },
    },
  ];
  assert.deepEqual(computeLiveHitRates(compactionOnly), { aggregate: 75, latest: null });

  // 9g. Mixed sequence: assistant1 -> toolResult -> compaction -> assistant2 -> toolResult
  const mixedSequence = [
    {
      type: "message",
      message: {
        role: "user",
        content: "hello",
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 300, cacheRead: 700, cacheWrite: 0 }, // 70% (denom 1000)
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        usage: { input: 100, cacheRead: 0, cacheWrite: 0 }, // 0% (denom 100)
      },
    },
    {
      type: "compaction",
      usage: { input: 50, cacheRead: 50, cacheWrite: 0 }, // 50% (denom 100)
    },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 100, cacheRead: 900, cacheWrite: 0 }, // 90% (denom 1000)
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        usage: { input: 50, cacheRead: 50, cacheWrite: 0 }, // 50% (denom 100)
      },
    },
  ];
  // Aggregate: (700 + 0 + 50 + 900 + 50) / (1000 + 100 + 100 + 1000 + 100) = 1700 / 2300 = 73.9% -> 74%
  // Latest: assistant 2 = 900 / 1000 = 90%
  assert.deepEqual(computeLiveHitRates(mixedSequence), { aggregate: 74, latest: 90 });

  // 9h. Messages with denom=0 or no usage
  const zeroUsageEntries = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: "test",
      },
    },
  ];
  assert.deepEqual(computeLiveHitRates(zeroUsageEntries), { aggregate: null, latest: null });

  // 9i. Cache-unsupported model (cacheRead=0, cacheWrite=0, input>0): n/a, never 0%
  const noCacheEntries = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 1000, cacheRead: 0, cacheWrite: 0 },
      },
    },
  ];
  assert.deepEqual(computeLiveHitRates(noCacheEntries), { aggregate: null, latest: null });

  // 9j. Latest residue: newest assistant round without cache interaction clears latest to null
  const residueEntries = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 100, cacheRead: 900, cacheWrite: 0 }, // 90%
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 1000, cacheRead: 0, cacheWrite: 0 }, // no cache round
      },
    },
  ];
  // Aggregate still counts both: (900 + 0) / (1000 + 1000) = 45%
  assert.deepEqual(computeLiveHitRates(residueEntries), { aggregate: 45, latest: null });

  // 9k. Latest residue: newest assistant round with denom=0 clears latest to null
  const zeroDenomLatest = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 100, cacheRead: 900, cacheWrite: 0 }, // 90%
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0 }, // denom 0
      },
    },
  ];
  // Zero-denom entry adds nothing to the denominator: aggregate stays 900/1000 = 90%
  assert.deepEqual(computeLiveHitRates(zeroDenomLatest), { aggregate: 90, latest: null });

  // 9l. cacheWrite-only round still counts (cache interaction happened), latest = 0%
  const writeOnly = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 100, cacheRead: 0, cacheWrite: 50 },
      },
    },
  ];
  assert.deepEqual(computeLiveHitRates(writeOnly), { aggregate: 0, latest: 0 });

  // 9m. cacheWrite must be accumulated from toolResult / compaction branches too
  const mixedWrite = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 100, cacheRead: 0, cacheWrite: 50 },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        usage: { input: 100, cacheRead: 100, cacheWrite: 20 },
      },
    },
    {
      type: "compaction",
      usage: { input: 100, cacheRead: 100, cacheWrite: 30 },
    },
  ];
  // read=200, write=100, denom=(150+220+230)=600 -> 200/600 = 33.3% -> 33%
  assert.deepEqual(computeLiveHitRates(mixedWrite), { aggregate: 33, latest: 0 });

  // 9n. resetBaseline restricts the scan to entries appended after reset
  const baselineEntries = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 200, cacheRead: 800, cacheWrite: 0 }, // 80%
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 50, cacheRead: 950, cacheWrite: 0 }, // 95%
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 1000, cacheRead: 0, cacheWrite: 0 }, // no cache
      },
    },
  ];
  // Baseline 0 -> full scope: (800+950+0)/(1000+1000+1000) = 58%, latest null
  assert.deepEqual(computeLiveHitRates(baselineEntries, 0), { aggregate: 58, latest: null });
  // Baseline 1 -> last two only: (950+0)/(1000+1000) = 48%, latest null
  assert.deepEqual(computeLiveHitRates(baselineEntries, 1), { aggregate: 48, latest: null });
  // Baseline 2 -> only the no-cache entry: n/a
  assert.deepEqual(computeLiveHitRates(baselineEntries, 2), { aggregate: null, latest: null });
  // Baseline equal to length -> nothing after reset: n/a
  assert.deepEqual(computeLiveHitRates(baselineEntries, 3), { aggregate: null, latest: null });
  // Baseline beyond length -> trimmed/replaced session: safe fallback to n/a, never wrong window
  assert.deepEqual(computeLiveHitRates(baselineEntries, 4), { aggregate: null, latest: null });

  // 9o. Sequence: assistant(has usage, 80%) -> toolResult -> assistant(NO usage)
  // The final assistant carries no usage (interrupt / error / injected message):
  // latest must clear to null (no stale 80%), and the aggregate must still be
  // computed from the entries that DO carry usage (not 0, not null).
  const noUsageTrail = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 200, cacheRead: 800, cacheWrite: 0 }, // 80% (denom 1000)
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        usage: { input: 100, cacheRead: 0, cacheWrite: 0 }, // contributes denom only (denom 100)
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        // no usage field
      },
    },
  ];
  // Aggregate: (800 + 0) / (1000 + 100) = 800 / 1100 = 72.7% -> 73%
  assert.deepEqual(computeLiveHitRates(noUsageTrail), { aggregate: 73, latest: null });

  // 9p. Sequence: assistant(has usage, 80%) -> assistant(no usage) -> toolResult(has usage)
  // The no-usage assistant in the middle clears latest to null; the trailing
  // toolResult contributes to aggregate only, latest stays null.
  const noUsageMiddle = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 200, cacheRead: 800, cacheWrite: 0 }, // 80% (denom 1000)
      },
    },
    {
      type: "message",
      message: { role: "assistant" }, // no usage -> latest null
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        usage: { input: 100, cacheRead: 100, cacheWrite: 0 }, // contributes to aggregate
      },
    },
  ];
  // Aggregate: (800 + 100) / (1000 + 200) = 900 / 1200 = 75%; latest remains null
  assert.deepEqual(computeLiveHitRates(noUsageMiddle), { aggregate: 75, latest: null });
}

console.log("All hit-rate and footer tests passed!");


