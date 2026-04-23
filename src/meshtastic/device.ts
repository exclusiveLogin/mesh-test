import { EventEmitter } from "node:events";
import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportHTTP } from "@meshtastic/transport-http";
import type { Destination } from "../shared/types.js";

type MessagePacket = Types.PacketMetadata<string>;
type TelemetryPacket = Types.PacketMetadata<Protobuf.Telemetry.Telemetry>;

export interface IncomingTextMessage {
  text: string;
  from: number;
  to: number;
  channel: number;
  rxTime: Date;
  id: number;
}

export interface RawMeshPacketEvent {
  id: number;
  from: number;
  to: number;
  channel: number;
  variant: "decoded" | "encrypted" | "unknown";
  portNumName?: string;
  payloadSize: number;
}

export interface SendTextOptions {
  destination?: Destination;
  channel?: number;
  wantAck?: boolean;
}

export interface MeshtasticDeviceOptions {
  /**
   * Минимальный уровень внутреннего tslog-логгера @meshtastic/core.
   * 0 silly | 1 trace | 2 debug | 3 info | 4 warn | 5 error | 6 fatal.
   * Если не указан — берётся из MESHTASTIC_LIB_LOG_LEVEL или 4 (warn).
   */
  libLogLevel?: number;
  /**
   * Период heartbeat-пинга, мс. Обычно не нужен если что-то активно
   * отправляется или включён autoReconnect. 0 = выключить (default).
   */
  heartbeatMs?: number;
  /** Автоматически переподключаться после дисконнекта. По умолчанию true. */
  autoReconnect?: boolean;
  /** Пауза перед reconnect, мс. По умолчанию 2000. */
  reconnectDelayMs?: number;
}

/**
 * Высокоуровневая обёртка над @meshtastic/core + @meshtastic/transport-http.
 * Не возимся с protobuf и endpoint-ами вручную.
 *
 * Эмитит событие `libLog` для каждой строки tslog из @meshtastic/core,
 * чтобы её можно было пристегнуть в наш dashboard / file log.
 */
export class MeshtasticDevice extends EventEmitter {
  private device: MeshDevice | null = null;
  private channelUtilization: number | null = null;
  private lastStatus: Types.DeviceStatusEnum | null = null;
  private shuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;

  constructor(
    private readonly address: string,
    private readonly tls: boolean = false,
    private readonly options: MeshtasticDeviceOptions = {}
  ) {
    super();
    this.heartbeatMs = options.heartbeatMs ?? 0;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2000;
  }

  async connect(): Promise<void> {
    this.shuttingDown = false;
    this.emit("connecting", this.address);
    const transport = await TransportHTTP.create(this.address, this.tls);
    const device = new MeshDevice(transport);
    this.device = device;

    // @meshtastic/core использует tslog и по умолчанию пишет прямо в stdout.
    // 1) Выставляем minLevel — фильтр всего шума.
    // 2) Переопределяем transportFormatted, чтобы вместо stdout либа
    //    эмитила в нас событие "libLog" — мы положим его в дашборд / файл.
    // 0 silly | 1 trace | 2 debug | 3 info | 4 warn | 5 error | 6 fatal
    const envLevel = process.env.MESHTASTIC_LIB_LOG_LEVEL;
    const minLevel =
      this.options.libLogLevel ?? (Number.isFinite(Number(envLevel)) ? Number(envLevel) : 4);
    type TsLogSettings = {
      minLevel?: number;
      overwrite?: {
        transportFormatted?: (
          logMetaMarkup: string,
          logArgs: unknown[],
          logErrors: unknown[]
        ) => void;
      };
    };
    const deviceLog = (device as unknown as { log?: { settings?: TsLogSettings } }).log;
    if (deviceLog?.settings) {
      deviceLog.settings.minLevel = minLevel;
      deviceLog.settings.overwrite = {
        ...(deviceLog.settings.overwrite ?? {}),
        transportFormatted: (meta, args, errors) => {
          const stripAnsi = (s: string): string =>
            s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r?\n$/, "");
          const line =
            stripAnsi(String(meta ?? "")) +
            args
              .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
              .join(" ") +
            (errors.length ? " " + errors.map((e) => String(e)).join(" ") : "");
          this.emit("libLog", line.trim());
        },
      };
    }

    device.events.onDeviceStatus.subscribe((status: Types.DeviceStatusEnum) => {
      this.lastStatus = status;
      this.emit("status", status, Types.DeviceStatusEnum[status]);
      if (status === Types.DeviceStatusEnum.DeviceConnected) {
        this.emit("connected");
      }
      if (status === Types.DeviceStatusEnum.DeviceDisconnected) {
        this.emit("disconnected");
        this.scheduleReconnect();
      }
    });

    device.events.onMessagePacket.subscribe((packet: MessagePacket) => {
      const event: IncomingTextMessage = {
        text: packet.data,
        from: packet.from,
        to: packet.to,
        channel: Number(packet.channel),
        rxTime: packet.rxTime,
        id: packet.id,
      };
      this.emit("text", event);
    });

    device.events.onMeshPacket.subscribe((packet: Protobuf.Mesh.MeshPacket) => {
      const variantCase = packet.payloadVariant?.case;
      let variant: RawMeshPacketEvent["variant"] = "unknown";
      let portNumName: string | undefined;
      let payloadSize = 0;

      if (variantCase === "decoded") {
        variant = "decoded";
        const data = packet.payloadVariant.value;
        portNumName = Protobuf.Portnums.PortNum[data.portnum] ?? String(data.portnum);
        payloadSize = data.payload?.length ?? 0;
      } else if (variantCase === "encrypted") {
        variant = "encrypted";
        payloadSize = packet.payloadVariant.value?.length ?? 0;
      }

      const raw: RawMeshPacketEvent = {
        id: packet.id,
        from: packet.from,
        to: packet.to,
        channel: Number(packet.channel),
        variant,
        portNumName,
        payloadSize,
      };
      this.emit("rawPacket", raw);
    });

    device.events.onTelemetryPacket.subscribe((packet: TelemetryPacket) => {
      const telemetry = packet.data;
      const variant = telemetry.variant;
      if (variant?.case === "deviceMetrics") {
        const metrics = variant.value;
        if (typeof metrics.channelUtilization === "number") {
          this.channelUtilization = metrics.channelUtilization;
          this.emit("channelUtilization", this.channelUtilization);
        }
      }
    });

    device.events.onMyNodeInfo.subscribe((info: Protobuf.Mesh.MyNodeInfo) => {
      this.emit("myNodeInfo", info);
    });

    await device.configure();

    // HTTP-транспорт рвёт соединение по read-timeout, если устройство
    // ничего не шлёт. Heartbeat гоняет ToRadio { heartbeat } и устройство
    // отвечает, чем держит канал живым.
    if (this.heartbeatMs > 0) {
      const deviceWithHeartbeat = device as unknown as {
        setHeartbeatInterval?: (ms: number) => void;
      };
      deviceWithHeartbeat.setHeartbeatInterval?.(this.heartbeatMs);
    }
  }

  async sendText(text: string, options: SendTextOptions = {}): Promise<number> {
    if (!this.device) {
      throw new Error("Device is not connected");
    }
    const destination = options.destination ?? "broadcast";
    const wantAck = options.wantAck ?? false;
    const channel = (options.channel ?? 0) as Types.ChannelNumber;
    return this.device.sendText(text, destination, wantAck, channel);
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.device?.disconnect();
    this.device = null;
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.shuttingDown) return;
    if (this.reconnectTimer) return;
    this.emit(
      "libLog",
      `↩️ scheduling reconnect in ${this.reconnectDelayMs}ms to ${this.address}`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.emit("libLog", `⚠️ reconnect failed: ${String(err)}`);
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
  }

  getChannelUtilization(): number | null {
    return this.channelUtilization;
  }

  getAddress(): string {
    return this.address;
  }

  getStatusLabel(): string {
    if (this.lastStatus === null) return "n/a";
    return Types.DeviceStatusEnum[this.lastStatus] ?? String(this.lastStatus);
  }
}

export type { Protobuf };
