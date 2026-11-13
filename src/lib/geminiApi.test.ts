import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GeminiApiKeyError,
  buildValidGeminiContents,
  markGeminiKeyRejected,
  resolveGeminiApiKey,
} from "./geminiApi";

test("Gemini key error classifications", () => {
  const missingErr = new GeminiApiKeyError("Missing key", "MISSING_KEY");
  assert.equal(missingErr.code, "MISSING_KEY");
  assert.equal(missingErr.name, "GeminiApiKeyError");

  const revokedErr = new GeminiApiKeyError("Revoked key", "REVOKED_KEY");
  assert.equal(revokedErr.code, "REVOKED_KEY");
});

test("buildValidGeminiContents normalizes conversation history for direct Gemini streaming", () => {
  const history = [
    { role: "assistant" as const, content: "Hello! How can I help?" },
    { role: "user" as const, content: "yo" },
    { role: "assistant" as const, content: "Yo! Ready to manage your store." },
  ];
  const contents = buildValidGeminiContents(history, "what is my stock?");
  assert.ok(contents.length >= 2);
  // First turn should be 'user' (never starts with model)
  assert.equal(contents[0].role, "user");
  // Last turn must be 'user' with the prompt
  assert.equal(contents[contents.length - 1].role, "user");
  assert.ok(contents[contents.length - 1].parts[0].text.includes("what is my stock?"));
});

test("localStorage key resolution and rejection handling", async () => {
  const dummyKey = "AIzaSyTestKeyForResolution987654321";
  (globalThis as any).localStorage = {
    _data: {} as Record<string, string>,
    getItem(k: string) {
      return this._data[k] || null;
    },
    setItem(k: string, v: string) {
      this._data[k] = v;
    },
    removeItem(k: string) {
      delete this._data[k];
    },
  };

  localStorage.setItem("buzz_gemini_api_key", dummyKey);
  const resolved = await resolveGeminiApiKey();
  assert.equal(resolved, dummyKey);

  markGeminiKeyRejected(dummyKey);
  assert.equal(localStorage.getItem("buzz_gemini_api_key"), null);
});
