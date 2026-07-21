export const TELEGRAM_NOTIFICATION_TIMEOUT_MS = 1_500;

const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
const TRANSACTION_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function optionalEnvironmentValue(environment, name) {
  const value = typeof environment?.[name] === "string" ? environment[name] : "";
  return value && value === value.trim() ? value : "";
}

function notificationMessage({ serviceName, amount, network, transaction, settledAt }) {
  if (!TRANSACTION_PATTERN.test(transaction)) {
    const error = new Error("Telegram notification event is missing a valid transaction");
    error.code = "telegram_notification_invalid_event";
    throw error;
  }

  const timestamp = new Date(settledAt);
  if (Number.isNaN(timestamp.getTime())) {
    const error = new Error("Telegram notification event is missing a valid timestamp");
    error.code = "telegram_notification_invalid_event";
    throw error;
  }

  return [
    "Conviction paid call settled",
    `Service: ${serviceName}`,
    `Amount: ${amount}`,
    `Network: X Layer (${network})`,
    `Transaction: ${transaction}`,
    `Explorer: https://www.oklink.com/xlayer/tx/${transaction}`,
    `Settled: ${timestamp.toISOString()}`,
  ].join("\n");
}

function notificationError(code, status = undefined) {
  const error = new Error(
    code === "telegram_notification_timeout"
      ? "Telegram notification timed out"
      : "Telegram notification failed",
  );
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

export function createTelegramNotifier(
  environment,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = TELEGRAM_NOTIFICATION_TIMEOUT_MS,
  } = {},
) {
  const botToken = optionalEnvironmentValue(environment, "TELEGRAM_BOT_TOKEN");
  const chatId = optionalEnvironmentValue(environment, "TELEGRAM_CHAT_ID");

  if (!botToken || !chatId) {
    return async function disabledTelegramNotifier() {
      return { sent: false, reason: "disabled" };
    };
  }

  if (typeof fetchImpl !== "function") {
    throw notificationError("telegram_notification_configuration_error");
  }

  const requestTimeoutMs =
    Number.isInteger(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : TELEGRAM_NOTIFICATION_TIMEOUT_MS;
  const endpoint = `${TELEGRAM_API_ORIGIN}/bot${botToken}/sendMessage`;

  return async function notifyTelegram(event) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: notificationMessage(event),
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });

      if (!response?.ok) {
        throw notificationError("telegram_notification_failed", response?.status);
      }

      const telegramResult = await response.json();
      if (telegramResult?.ok !== true) {
        throw notificationError("telegram_notification_failed", response.status);
      }

      return { sent: true };
    } catch (error) {
      if (error?.code?.startsWith("telegram_notification_")) throw error;
      if (controller.signal.aborted) {
        throw notificationError("telegram_notification_timeout");
      }
      throw notificationError("telegram_notification_failed");
    } finally {
      clearTimeout(timeout);
    }
  };
}
