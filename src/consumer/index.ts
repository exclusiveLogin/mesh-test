import "dotenv/config";
import chalk from "chalk";
import type { WirePayload } from "../shared/types.js";
import type { IncomingTextMessage, RawMeshPacketEvent } from "../meshtastic/device.js";
import { MeshtasticDevice } from "../meshtastic/device.js";
import { FileLogger, Screen } from "../shared/screen.js";

const address =
  process.env.MESHTASTIC_CONSUMER_ADDRESS ??
  process.env.MESHTASTIC_ADDRESS ??
  "127.0.0.1";
const tls = (process.env.MESHTASTIC_CONSUMER_TLS ?? process.env.MESHTASTIC_TLS ?? "0") === "1";
const verboseLogs = (process.env.CONSUMER_VERBOSE_LOGS ?? "0") !== "0";
const uiMode = (process.env.CLI_UI_MODE ?? "fullscreen").toLowerCase();
const logFilePath =
  process.env.CONSUMER_LOG_FILE ?? (uiMode === "fullscreen" ? "logs/consumer.log" : null);
const channelFilterRaw = process.env.MESHTASTIC_CONSUMER_CHANNEL;
const channelFilter: number | null =
  channelFilterRaw && channelFilterRaw.trim() !== "" ? Number(channelFilterRaw) : null;

const now = (): string => new Date().toISOString().slice(11, 19);

const formatNodeId = (n: number): string =>
  `!${(n >>> 0).toString(16).padStart(8, "0")}`;

async function main(): Promise<void> {
  const device = new MeshtasticDevice(address, tls, {
    heartbeatMs: Number(process.env.HEARTBEAT_MS ?? 0),
    autoReconnect: (process.env.AUTO_RECONNECT ?? "1") !== "0",
    reconnectDelayMs: Number(process.env.RECONNECT_DELAY_MS ?? 2000),
  });
  const fileLogger = new FileLogger(logFilePath);
  const eventLog: string[] = [];
  const counters = {
    packets: 0,
    text: 0,
    raw: 0,
    meshRaw: 0,
    meshEncrypted: 0,
    meshDecoded: 0,
    byNode: new Map<number, number>(),
    byPort: new Map<string, number>(),
  };
  let utilization: number | null = null;

  const pushEvent = (line: string): void => {
    eventLog.unshift(`${chalk.dim(now())} ${line}`);
    if (eventLog.length > 20) eventLog.pop();
    fileLogger.log(`[consumer] ${line}`);
    if (verboseLogs && uiMode !== "fullscreen") {
      console.error(`[consumer ${now()}] ${line}`);
    }
    screen.redraw();
  };

  const render = (): string[] => {
    const nodesTop = [...counters.byNode.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([node, count]) => `  ${formatNodeId(node)}: ${count}`);

    const portsTop = [...counters.byPort.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([port, count]) => `  ${port}: ${count}`);

    return [
      chalk.bold.green("=== CONSUMER DASHBOARD ==="),
      `device: ${chalk.white(device.getAddress())}   status: ${chalk.white(device.getStatusLabel())}   ui=${uiMode} (event-driven)`,
      `filter: channel=${channelFilter ?? "any"}   log=${logFilePath ?? "stderr"}`,
      `text packets: ${chalk.green(counters.text)} (parsed) / ${chalk.yellow(counters.raw)} (raw) / total=${chalk.white(counters.packets)}`,
      `mesh pkts:    total=${chalk.white(counters.meshRaw)} decoded=${chalk.green(counters.meshDecoded)} encrypted=${chalk.red(counters.meshEncrypted)}`,
      `channel-utilization: ${utilization ?? "n/a"}`,
      "",
      chalk.bold("by portnum"),
      ...(portsTop.length > 0 ? portsTop : [chalk.dim("  no data")]),
      "",
      chalk.bold("top nodes"),
      ...(nodesTop.length > 0 ? nodesTop : [chalk.dim("  no data")]),
      "",
      chalk.bold("live log") + chalk.dim("   (Ctrl+C to exit)"),
      ...(eventLog.length > 0 ? eventLog : [chalk.dim("waiting for events...")]),
    ];
  };

  const screen = new Screen(render);

  device.on("connecting", (addr) => pushEvent(`${chalk.blue("connecting")} ${String(addr)}`));
  device.on("connected", () => pushEvent(chalk.green("connected")));
  device.on("disconnected", () => pushEvent(chalk.yellow("disconnected")));
  device.on("status", (_, label: string) => pushEvent(chalk.dim(`status=${label}`)));
  device.on("channelUtilization", (v: number) => {
    utilization = v;
    pushEvent(chalk.magenta(`channel-utilization=${v.toFixed(2)}`));
  });
  device.on("myNodeInfo", (info) => {
    pushEvent(
      chalk.blue(
        `myNodeInfo this=${info.myNodeNum != null ? formatNodeId(Number(info.myNodeNum)) : "?"}`
      )
    );
  });
  device.on("libLog", (line: string) => {
    pushEvent(chalk.dim(`[lib] ${line}`));
  });

  device.on("rawPacket", (pkt: RawMeshPacketEvent) => {
    counters.meshRaw += 1;
    const port = pkt.portNumName ?? (pkt.variant === "encrypted" ? "ENCRYPTED" : "UNKNOWN");
    counters.byPort.set(port, (counters.byPort.get(port) ?? 0) + 1);

    if (pkt.variant === "decoded") {
      counters.meshDecoded += 1;
      pushEvent(
        chalk.dim(
          `[mesh] ${port} from=${formatNodeId(pkt.from)} to=${formatNodeId(pkt.to)} ch=${pkt.channel} size=${pkt.payloadSize}`
        )
      );
    } else if (pkt.variant === "encrypted") {
      counters.meshEncrypted += 1;
      pushEvent(
        chalk.red(
          `[mesh] ENCRYPTED from=${formatNodeId(pkt.from)} to=${formatNodeId(pkt.to)} ch=${pkt.channel} size=${pkt.payloadSize} (PSK mismatch?)`
        )
      );
    } else {
      pushEvent(
        chalk.yellow(`[mesh] unknown variant from=${formatNodeId(pkt.from)} ch=${pkt.channel}`)
      );
    }
  });

  device.on("text", (msg: IncomingTextMessage) => {
    if (channelFilter !== null && msg.channel !== channelFilter) {
      pushEvent(chalk.dim(`[skip] ch=${msg.channel} != filter ${channelFilter}`));
      return;
    }
    counters.packets += 1;
    counters.byNode.set(msg.from, (counters.byNode.get(msg.from) ?? 0) + 1);

    let parsed: WirePayload | null = null;
    try {
      const data = JSON.parse(msg.text) as WirePayload;
      if (
        data &&
        typeof data.u === "string" &&
        typeof data.s === "number" &&
        typeof data.t === "string"
      ) {
        parsed = data;
      }
    } catch {
      // not our JSON packet
    }

    if (parsed) {
      counters.text += 1;
      pushEvent(
        [
          chalk.bold.green("[pkt]"),
          `from=${formatNodeId(msg.from)}`,
          `ch=${msg.channel}`,
          `seq=${parsed.s}`,
          `id=${parsed.u}`,
          `text=${chalk.white(parsed.t)}`,
        ].join(" ")
      );
    } else {
      counters.raw += 1;
      pushEvent(
        chalk.dim(
          `[raw] from=${formatNodeId(msg.from)} ch=${msg.channel} text=${msg.text}`
        )
      );
    }
  });

  pushEvent(chalk.blue(`starting consumer to ${address}`));
  if (uiMode === "fullscreen") {
    screen.start();
  }
  try {
    await device.connect();
  } catch (error) {
    screen.stop();
    fileLogger.close();
    throw error;
  }
}

main().catch((error) => {
  console.error(chalk.red("consumer failed:"), error);
  process.exitCode = 1;
});
