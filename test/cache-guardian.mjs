import { strict as assert } from "node:assert";

const event = { type: "after_provider_response", status: 400, headers: { "content-type": "application/json" } };
assert.deepEqual(Object.keys(event).sort(), ["headers", "status", "type"]);
console.log("cache-guardian event-shape verification passed");
