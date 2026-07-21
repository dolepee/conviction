import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramNotifier,
  TELEGRAM_NOTIFICATION_TIMEOUT_MS,
} from "../src/telegram-notifier.mjs";

const TRANSACTION = `0x${"cd".repeat(32)}`;
const EVENT = Object.freeze({
  serviceName: "Bounded YES/NO Position Card",
  amount: "0.05 USD₮0",
  network: "eip155:196",
  transaction: TRANSACTION,
  settledAt: "2026-07-21T12:34:56.000Z",
});

test("Telegram notifications are disabled when either credential is absent or padded", async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    throw new Error("fetch must not run");
  };

  for (const environment of [
    {},
    { TELEGRAM_BOT_TOKEN: "token" },
    { TELEGRAM_CHAT_ID: "123" },
    { TELEGRAM_BOT_TOKEN: " token ", TELEGRAM_CHAT_ID: "123" },
  ]) {
    const notify = createTelegramNotifier(environment, { fetchImpl });
    assert.deepEqual(await notify(EVENT), { sent: false, reason: "disabled" });
  }
  assert.equal(fetches, 0);
});

test("Telegram receives only fixed settlement metadata and the canonical explorer link", async () => {
  const calls = [];
  const notify = createTelegramNotifier(
    { TELEGRAM_BOT_TOKEN: "test-bot-token", TELEGRAM_CHAT_ID: "-100123" },
    {
      async fetchImpl(url, options) {
        calls.push({ url, options });
        return { ok: true, status: 200, async json() { return { ok: true }; } };
      },
    },
  );

  const result = await notify({
    ...EVENT,
    buyer: "private-buyer",
    rationale: "private-rationale",
    paymentPayload: "private-payment-payload",
    secret: "private-secret",
  });

  assert.deepEqual(result, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.telegram.org/bottest-bot-token/sendMessage",
  );
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.headers, { "content-type": "application/json" });
  assert.ok(calls[0].options.signal instanceof AbortSignal);

  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.chat_id, "-100123");
  assert.equal(payload.disable_web_page_preview, true);
  assert.match(payload.text, /Bounded YES\/NO Position Card/);
  assert.match(payload.text, /0\.05 USD₮0/);
  assert.match(payload.text, /X Layer \(eip155:196\)/);
  assert.match(payload.text, new RegExp(TRANSACTION));
  assert.match(
    payload.text,
    new RegExp(`https://www\\.oklink\\.com/xlayer/tx/${TRANSACTION}`),
  );
  assert.match(payload.text, /2026-07-21T12:34:56\.000Z/);
  for (const privateValue of [
    "private-buyer",
    "private-rationale",
    "private-payment-payload",
    "private-secret",
  ]) {
    assert.equal(payload.text.includes(privateValue), false);
  }
});

test("Telegram HTTP and API-level failures expose only sanitized errors", async () => {
  const token = "do-not-leak-this-token";
  for (const response of [
    { ok: false, status: 502, async json() { return { ok: false }; } },
    { ok: true, status: 200, async json() { return { ok: false, description: token }; } },
  ]) {
    const notify = createTelegramNotifier(
      { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "123" },
      { fetchImpl: async () => response },
    );
    await assert.rejects(
      notify(EVENT),
      (error) => {
        assert.equal(error.code, "telegram_notification_failed");
        assert.equal(error.status, response.status);
        assert.equal(JSON.stringify(error).includes(token), false);
        assert.equal(error.message.includes(token), false);
        return true;
      },
    );
  }
});

test("Telegram notification calls have a bounded timeout", async () => {
  assert.equal(TELEGRAM_NOTIFICATION_TIMEOUT_MS, 1_500);
  const notify = createTelegramNotifier(
    { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_CHAT_ID: "123" },
    {
      timeoutMs: 5,
      fetchImpl(url, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted request");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      },
    },
  );

  await assert.rejects(
    notify(EVENT),
    (error) => error.code === "telegram_notification_timeout",
  );
});

test("invalid settlement metadata is rejected before Telegram is called", async () => {
  let fetches = 0;
  const notify = createTelegramNotifier(
    { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_CHAT_ID: "123" },
    {
      async fetchImpl() {
        fetches += 1;
        return { ok: true, status: 200, async json() { return { ok: true }; } };
      },
    },
  );

  for (const event of [
    { ...EVENT, transaction: "0x1234" },
    { ...EVENT, settledAt: "not-a-timestamp" },
  ]) {
    await assert.rejects(
      notify(event),
      (error) => error.code === "telegram_notification_invalid_event",
    );
  }
  assert.equal(fetches, 0);
});
