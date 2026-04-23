import "dotenv/config";
import { randomBytes } from "node:crypto";
import chalk from "chalk";
import { CircuitBreaker } from "../shared/circuitBreaker.js";
import { InMemoryBroker } from "../shared/queue.js";
import { sleep, withRetry } from "../shared/retry.js";
import type {
  Destination,
  MeshPacket,
  PacketStatus,
  ProducerConfig,
  WirePayload,
} from "../shared/types.js";
import { MeshtasticDevice } from "../meshtastic/device.js";
import { FileLogger, Screen } from "../shared/screen.js";

const parseDestination = (raw: string | undefined): Destination => {
  if (!raw) return "broadcast";
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "broadcast") return "broadcast";
  if (trimmed === "self") return "self";
  // Meshtastic nodeId format: "!0400a878" (hex, 8 chars, без 0x)
  if (trimmed.startsWith("!")) {
    const n = Number.parseInt(trimmed.slice(1), 16);
    if (!Number.isFinite(n)) {
      throw new Error(
        `Invalid MESHTASTIC_PRODUCER_DESTINATION "!${trimmed.slice(1)}" (expected !<hex>, e.g. !0400a878)`
      );
    }
    return n >>> 0;
  }
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    const n = Number.parseInt(trimmed, 16);
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid MESHTASTIC_PRODUCER_DESTINATION "${trimmed}"`);
    }
    return n >>> 0;
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    throw new Error(
      `Invalid MESHTASTIC_PRODUCER_DESTINATION "${trimmed}" (use "broadcast" | "self" | "!hex" | "0xhex" | decimal)`
    );
  }
  return n >>> 0;
};

const config: ProducerConfig = {
  batchSize: Number(process.env.BATCH_SIZE ?? 12),
  throttleMs: Number(process.env.THROTTLE_MS ?? 900),
  maxRetries: Number(process.env.MAX_RETRIES ?? 3),
  address:
    process.env.MESHTASTIC_PRODUCER_ADDRESS ??
    process.env.MESHTASTIC_ADDRESS ??
    "127.0.0.1",
  tls: (process.env.MESHTASTIC_PRODUCER_TLS ?? process.env.MESHTASTIC_TLS ?? "0") === "1",
  queueTickMs: Number(process.env.QUEUE_TICK_MS ?? 200),
  breakerFailures: Number(process.env.CB_FAILURE_THRESHOLD ?? 3),
  breakerResetMs: Number(process.env.CB_RESET_MS ?? 10_000),
  destination: parseDestination(process.env.MESHTASTIC_PRODUCER_DESTINATION),
  channel: Number(process.env.MESHTASTIC_PRODUCER_CHANNEL ?? 0),
  wantAck: (process.env.MESHTASTIC_PRODUCER_WANT_ACK ?? "1") === "1",
};

const destinationLabel = (dest: Destination): string => {
  if (dest === "broadcast") return "broadcast (all nodes)";
  if (dest === "self") return "self";
  const hex = (dest >>> 0).toString(16).padStart(8, "0");
  return `node !${hex} (0x${hex}, ${dest >>> 0})`;
};

const verboseLogs = (process.env.PRODUCER_VERBOSE_LOGS ?? "0") !== "0";
const uiMode = (process.env.CLI_UI_MODE ?? "fullscreen").toLowerCase();
const logFilePath =
  process.env.PRODUCER_LOG_FILE ?? (uiMode === "fullscreen" ? "logs/producer.log" : null);

const statusColor = (status: PacketStatus): ((text: string) => string) => {
  switch (status) {
    case "queued":
      return chalk.gray;
    case "sending":
      return chalk.cyan;
    case "sent":
      return chalk.green;
    case "retrying":
      return chalk.yellow;
    case "failed":
      return chalk.red;
  }
};

const stackBar = (size: number): string => {
  const width = 24;
  const filled = Math.min(width, size);
  return `${chalk.magenta("[" + "#".repeat(filled) + ".".repeat(width - filled) + "]")} ${size}`;
};

const now = (): string => new Date().toISOString().slice(11, 19);

// Короткий id пакета: 5 hex-символов (~1M вариантов).
// Достаточно для корреляции в рамках одного batch, зато экономит ~30 байт на пакет
// по сравнению с полным uuid v4 (важно в LoRa где payload ограничен).
const shortId = (): string => randomBytes(3).toString("hex").slice(0, 5);

const toWire = (packet: MeshPacket): WirePayload => ({
  u: packet.uuid,
  s: packet.seq,
  t: packet.text,
});

async function main(): Promise<void> {
  const broker = new InMemoryBroker<MeshPacket>();
  const device = new MeshtasticDevice(config.address, config.tls, {
    heartbeatMs: Number(process.env.HEARTBEAT_MS ?? 0),
    autoReconnect: (process.env.AUTO_RECONNECT ?? "1") !== "0",
    reconnectDelayMs: Number(process.env.RECONNECT_DELAY_MS ?? 2000),
  });
  const breaker = new CircuitBreaker(config.breakerFailures, config.breakerResetMs);
  const fileLogger = new FileLogger(logFilePath);
  const lastPackets: MeshPacket[] = [];
  const eventLog: string[] = [];
  const counters = { sent: 0, failed: 0, retry: 0 };
  let currentPacket: MeshPacket | null = null;
  let finished = false;

  const pushEvent = (line: string): void => {
    eventLog.unshift(`${chalk.dim(now())} ${line}`);
    if (eventLog.length > 20) {
      eventLog.pop();
    }
    fileLogger.log(`[producer] ${line}`);
    if (verboseLogs && uiMode !== "fullscreen") {
      console.error(`[producer ${now()}] ${line}`);
    }
    screen.redraw();
  };

  const render = (): string[] => {
    const current = currentPacket;
    const done = counters.sent + counters.failed;
    const pending = broker.size() + (current?.status === "sending" ? 1 : 0);
    const total = done + pending;
    const progress = total > 0 ? Math.round((done / total) * 100) : 100;
    const utilization = device.getChannelUtilization();

    return [
      chalk.bold.cyan("=== PRODUCER DASHBOARD ==="),
      `device: ${chalk.white(device.getAddress())}   status: ${chalk.white(device.getStatusLabel())}   ui=${uiMode} (event-driven)`,
      `target: ${chalk.white(destinationLabel(config.destination))}  channel=${chalk.white(config.channel)}  wantAck=${chalk.white(String(config.wantAck))}`,
      `log=${logFilePath ?? "stderr"}`,
      `queue:  ${stackBar(broker.size())}   progress: ${chalk.white(`${progress}%`)}`,
      `stats:  sent=${chalk.green(counters.sent)} failed=${chalk.red(counters.failed)} retries=${chalk.yellow(counters.retry)}`,
      current
        ? `current: #${current.seq} ${current.uuid} status=${statusColor(current.status)(current.status)} r=${current.retries}`
        : `current: ${chalk.dim(finished ? "done" : "idle")}`,
      `cb=${breaker.getState()}  channel-utilization=${utilization ?? "n/a"}`,
      "",
      chalk.bold("recent packets"),
      ...(lastPackets.length > 0
        ? lastPackets.map(
            (packet) =>
              `- #${packet.seq} ${packet.uuid} ${statusColor(packet.status)(packet.status)} r=${packet.retries}`
          )
        : [chalk.dim("  none yet")]),
      "",
      chalk.bold("event log") + chalk.dim("   (Ctrl+C to exit)"),
      ...(eventLog.length > 0 ? eventLog : [chalk.dim("no events yet")]),
    ];
  };

  const screen = new Screen(render);

  device.on("connecting", (addr) => pushEvent(`${chalk.blue("connecting")} ${String(addr)}`));
  device.on("connected", () => pushEvent(chalk.green(`connected ${device.getAddress()}`)));
  device.on("disconnected", () => pushEvent(chalk.yellow("disconnected")));
  device.on("status", (_, label: string) => pushEvent(chalk.dim(`status=${label}`)));
  device.on("channelUtilization", (v: number) =>
    pushEvent(chalk.magenta(`channel-utilization=${v.toFixed(2)}`))
  );
  device.on("libLog", (line: string) => {
    pushEvent(chalk.dim(`[lib] ${line}`));
  });

  pushEvent(chalk.blue(`starting producer to ${config.address}`));
  pushEvent(
    chalk.blue(
      `target: ${destinationLabel(config.destination)} | channel=${config.channel} | wantAck=${config.wantAck}`
    )
  );

  if (uiMode === "fullscreen") {
    screen.start();
  }

  try {
    await device.connect();

    for (let i = 1; i <= config.batchSize; i += 1) {
      broker.enqueue({
        uuid: shortId(),
        seq: i,
        createdAt: new Date().toISOString(),
        retries: 0,
        status: "queued",
        channelMetrics: { utilization: null, quality: "unknown" },
        text: `pkt-${i}`,
      });
    }

    pushEvent(chalk.green(`batch initialized (${config.batchSize})`));

    while (!broker.isEmpty()) {
      const packet = broker.dequeue();
      if (!packet) {
        await sleep(config.queueTickMs);
        continue;
      }
      currentPacket = packet;

      if (!breaker.canRequest()) {
        packet.status = "retrying";
        packet.retries += 1;
        counters.retry += 1;
        broker.enqueue(packet);
        pushEvent(chalk.yellow(`cb-open requeue #${packet.seq}`));
        await sleep(config.queueTickMs);
        continue;
      }

      packet.status = "sending";
      pushEvent(
        chalk.cyan(
          `sending #${packet.seq} ${packet.uuid} -> ${destinationLabel(config.destination)} ch=${config.channel}`
        )
      );

      try {
        await withRetry(
          async () => {
            await device.sendText(JSON.stringify(toWire(packet)), {
              destination: config.destination,
              channel: config.channel,
              wantAck: config.wantAck,
            });
          },
          {
            retries: config.maxRetries,
            initialDelayMs: Math.max(300, Math.floor(config.throttleMs / 2)),
            factor: 2,
          },
          (attempt, delay, err) => {
            packet.status = "retrying";
            packet.retries = attempt;
            counters.retry += 1;
            pushEvent(
              chalk.yellow(
                `retry #${packet.seq} attempt=${attempt} in ${delay}ms err=${String(err)}`
              )
            );
          }
        );

        packet.status = "sent";
        packet.channelMetrics.utilization = device.getChannelUtilization();
        breaker.onSuccess();
        counters.sent += 1;
        pushEvent(chalk.green(`sent #${packet.seq}`));
      } catch (error) {
        packet.status = "failed";
        packet.channelMetrics.note = `send error: ${String(error)}`;
        breaker.onFailure();
        counters.failed += 1;
        pushEvent(chalk.red(`failed #${packet.seq} ${String(error)}`));
      }

      lastPackets.unshift(packet);
      if (lastPackets.length > 8) {
        lastPackets.pop();
      }
      await sleep(config.throttleMs);
    }

    finished = true;
    currentPacket = null;
    pushEvent(chalk.green("producer finished batch."));
    await device.disconnect();

    // В fullscreen-режиме даём пользователю время посмотреть финальный дашборд
    if (uiMode === "fullscreen") {
      await sleep(3000);
    }
  } finally {
    screen.stop();
    fileLogger.close();
  }
}

main().catch((error) => {
  console.error(chalk.red("producer failed:"), error);
  process.exitCode = 1;
});
