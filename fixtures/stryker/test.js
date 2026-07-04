import assert from "node:assert/strict";
import { add } from "./lib/tested.js";

assert.equal(add(1, 2), 3);
assert.equal(add(-1, 1), 0);
console.log("ok");
